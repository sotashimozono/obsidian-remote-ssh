package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/extensions"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
)

type extensionRunner struct {
	mgr      *extensions.Manager
	logs     *extensions.LogStore
	vaultDir string
	seq      atomic.Int64
	slots    chan struct{}

	mu     sync.Mutex
	active map[string]activeInvocation
}

// activeInvocation tracks a running extension process.
//
// The daemon uses a single-principal model — one token minted at startup
// that every session authenticates with. *Session is a transport handle,
// not an identity, so there is no per-session authorization boundary.
// session is the (rebindable) stream target for live output; when nil,
// output is persisted to the log for replay by a future reattach.
type activeInvocation struct {
	session    *server.Session
	stop       func() error
	outputMode string
}

const maxConcurrentExtensionInvocations = 4

func NewExtensionRunner(mgr *extensions.Manager, logs *extensions.LogStore, vaultDir string) *extensionRunner {
	return &extensionRunner{
		mgr:      mgr,
		logs:     logs,
		vaultDir: vaultDir,
		slots:    make(chan struct{}, maxConcurrentExtensionInvocations),
		active:   map[string]activeInvocation{},
	}
}

func (r *extensionRunner) Schema() rpc.Handler {
	return func(_ context.Context, _ json.RawMessage) (interface{}, *rpc.Error) {
		return r.mgr.SchemaResult(), nil
	}
}

func (r *extensionRunner) Invoke() rpc.Handler {
	return func(ctx context.Context, raw json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.ExtensionInvokeParams
		if e := decodeParams("extension.invoke", raw, &p); e != nil {
			return nil, e
		}
		if strings.TrimSpace(p.InvocationID) != "" {
			return r.resumeInvoke(ctx, p)
		}
		if strings.TrimSpace(p.Tool) == "" {
			return nil, rpc.ErrInvalidParams("extension.invoke: tool is required")
		}
		cap, ok := r.mgr.ResolveTool(p.Tool)
		if !ok {
			return nil, rpc.ErrExtensionDenied(p.Tool)
		}
		if err := r.mgr.VerifyToolBinary(p.Tool); err != nil {
			return nil, rpc.ErrBinaryHashMismatch(p.Tool)
		}

		args, err := validateAndBuildArgs(cap, p.Args)
		if err != nil {
			return nil, rpc.ErrInvalidParams("extension.invoke: " + err.Error())
		}

		select {
		case r.slots <- struct{}{}:
		case <-ctx.Done():
			return nil, rpc.ErrInternal("extension.invoke: context canceled")
		}
		released := false
		releaseSlot := func() {
			if released {
				return
			}
			<-r.slots
			released = true
		}

		cmd := exec.Command(cap.Command, args...) // #nosec G204 - command is pinned by capabilities + startup hash verification

		if p.WorkingDir != "" {
			if !cap.AllowWorkingDir {
				releaseSlot()
				return nil, rpc.ErrInvalidParams("extension.invoke: workingDir is not allowed for this tool")
			}
			wd, werr := validateWorkingDir(r.vaultDir, p.WorkingDir)
			if werr != nil {
				releaseSlot()
				return nil, werr
			}
			cmd.Dir = wd
		}

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			releaseSlot()
			return nil, rpc.ErrInternal("extension.invoke: stdout pipe: " + err.Error())
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			releaseSlot()
			return nil, rpc.ErrInternal("extension.invoke: stderr pipe: " + err.Error())
		}

		if err := cmd.Start(); err != nil {
			releaseSlot()
			return nil, rpc.ErrInternal("extension.invoke: start: " + err.Error())
		}

		session := server.SessionFromContext(ctx)
		invocationID := fmt.Sprintf("inv-%d-%d", time.Now().UnixMilli(), r.seq.Add(1))
		persist := cap.PersistDefault
		if p.Persist != nil {
			persist = *p.Persist
		}
		r.registerInvocation(invocationID, session, cap.OutputMode, func() error {
			if cmd.Process == nil {
				return nil
			}
			return cmd.Process.Kill()
		})
		go r.streamProcess(invocationID, cmd, stdout, stderr, persist, cap.OutputMode, releaseSlot)

		return proto.ExtensionInvokeResult{InvocationID: invocationID, Accepted: true}, nil
	}
}

func (r *extensionRunner) Kill() rpc.Handler {
	return r.killForMethod("extension.kill")
}

func (r *extensionRunner) KillCompat() rpc.Handler {
	return r.killForMethod("cli.kill")
}

func (r *extensionRunner) resumeInvoke(ctx context.Context, p proto.ExtensionInvokeParams) (interface{}, *rpc.Error) {
	if p.ResumeFrom < 0 {
		return nil, rpc.ErrInvalidParams("extension.invoke: resumeFrom must be >= 0")
	}

	invocationID := strings.TrimSpace(p.InvocationID)
	session := server.SessionFromContext(ctx)

	// Fix #1: Check persisted log, not active map.
	// A completed invocation has no active entry but the log file exists.
	if r.logs == nil || !r.logs.HasLog(invocationID) {
		return nil, rpc.ErrInvalidParams("extension.invoke: unknown invocationId for resume")
	}

	// Determine output mode from active invocation (if still running).
	inv, isRunning := r.lookupInvocation(invocationID)
	outputMode := "batch"
	if isRunning {
		outputMode = inv.outputMode
	}

	// Fix #2: Replay-then-bind ordering.
	// Read persisted output BEFORE binding session to prevent live
	// stream batches from interleaving with historical replay.
	items, done, err := r.logs.ReplayFrom(invocationID, p.ResumeFrom)
	if err != nil {
		return nil, rpc.ErrInternal("extension.invoke: replay: " + err.Error())
	}

	// Bind session for live output AFTER replay is captured.
	r.rebindInvocation(invocationID, session)
	if len(items) > 0 {
		if err := sendReplay(session, outputMode, invocationID, items); err != nil {
			return nil, rpc.ErrInternal("extension.invoke: replay notify: " + err.Error())
		}
	}
	if done != nil {
		if err := session.SendNotification("cli.done", proto.CliDoneParams{
			InvocationID: invocationID,
			ExitCode:     done.ExitCode,
			Signal:       done.Signal,
		}); err != nil {
			return nil, rpc.ErrInternal("extension.invoke: replay done: " + err.Error())
		}
	}

	return proto.ExtensionInvokeResult{InvocationID: invocationID, Accepted: true}, nil
}

func (r *extensionRunner) killForMethod(methodName string) rpc.Handler {
	return func(ctx context.Context, raw json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.ExtensionKillParams
		if e := decodeParams(methodName, raw, &p); e != nil {
			return nil, e
		}
		if strings.TrimSpace(p.InvocationID) == "" {
			return nil, rpc.ErrInvalidParams(methodName + ": invocationId is required")
		}

		inv, ok := r.lookupInvocation(p.InvocationID)
		if !ok {
			return proto.ExtensionKillResult{InvocationID: p.InvocationID, Killed: false}, nil
		}

		err := inv.stop()
		if err != nil && !errors.Is(err, os.ErrProcessDone) {
			return nil, rpc.ErrInternal(methodName + ": " + err.Error())
		}
		// Don't unregister here — streamProcess's deferred unregisterInvocation
		// handles cleanup after sending cli.done.
		return proto.ExtensionKillResult{InvocationID: p.InvocationID, Killed: true}, nil
	}
}

func (r *extensionRunner) registerInvocation(invocationID string, session *server.Session, outputMode string, stop func() error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active[invocationID] = activeInvocation{session: session, outputMode: outputMode, stop: stop}
}

func (r *extensionRunner) lookupInvocation(invocationID string) (activeInvocation, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	inv, ok := r.active[invocationID]
	return inv, ok
}

func (r *extensionRunner) unregisterInvocation(invocationID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.active, invocationID)
}

func (r *extensionRunner) currentInvocationSession(invocationID string) *server.Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	inv, ok := r.active[invocationID]
	if !ok {
		return nil
	}
	return inv.session
}

func (r *extensionRunner) rebindInvocation(invocationID string, session *server.Session) (activeInvocation, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	inv, ok := r.active[invocationID]
	if !ok {
		return activeInvocation{}, false
	}
	inv.session = session
	r.active[invocationID] = inv
	return inv, true
}

func sendReplay(session *server.Session, outputMode, invocationID string, items []proto.CliOutputBatchItem) error {
	if outputMode == "single" {
		for _, it := range items {
			if err := session.SendNotification("cli.output", proto.CliOutputParams{
				InvocationID: invocationID,
				Stream:       it.Stream,
				Data:         it.Data,
				Seq:          it.Seq,
			}); err != nil {
				return err
			}
		}
		return nil
	}
	return session.SendNotification("cli.output.batch", proto.CliOutputBatchParams{
		InvocationID: invocationID,
		Items:        items,
	})
}

func validateAndBuildArgs(cap proto.ExtensionCapability, provided map[string]string) ([]string, error) {
	if provided == nil {
		provided = map[string]string{}
	}
	known := map[string]struct{}{}
	for _, rule := range cap.Args {
		known[rule.Name] = struct{}{}
		val := provided[rule.Name]
		if strings.HasPrefix(strings.TrimLeft(val, " \t\r\n"), "-") && !rule.AllowFlags {
			return nil, fmt.Errorf("arg %q must not start with '-'; set allowFlags to opt in", rule.Name)
		}
		if rule.Required && strings.TrimSpace(val) == "" {
			return nil, fmt.Errorf("arg %q is required", rule.Name)
		}
		if rule.MaxLength > 0 && len(val) > rule.MaxLength {
			return nil, fmt.Errorf("arg %q exceeds maxLength %d", rule.Name, rule.MaxLength)
		}
		if strings.TrimSpace(rule.Pattern) != "" && val != "" {
			rx, err := regexp.Compile(rule.Pattern)
			if err != nil {
				return nil, fmt.Errorf("arg %q pattern compile failed", rule.Name)
			}
			if !rx.MatchString(val) {
				return nil, fmt.Errorf("arg %q does not match required pattern", rule.Name)
			}
		}
	}
	for name := range provided {
		if _, ok := known[name]; !ok {
			return nil, fmt.Errorf("arg %q is not allowed", name)
		}
	}
	out := make([]string, 0, len(cap.Args))
	for _, rule := range cap.Args {
		if v, ok := provided[rule.Name]; ok && v != "" {
			out = append(out, v)
		}
	}
	return out, nil
}

func (r *extensionRunner) streamProcess(invocationID string, cmd *exec.Cmd, stdout io.ReadCloser, stderr io.ReadCloser, persist bool, outputMode string, releaseSlot func()) {
	defer releaseSlot()
	defer r.unregisterInvocation(invocationID)
	itemsCh := make(chan proto.CliOutputBatchItem, 256)
	var wg sync.WaitGroup
	wg.Add(2)
	go r.scanStream(&wg, stdout, "stdout", itemsCh)
	go r.scanStream(&wg, stderr, "stderr", itemsCh)
	go func() {
		wg.Wait()
		close(itemsCh)
	}()

	persistEnabled := persist && r.logs != nil
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	batch := make([]proto.CliOutputBatchItem, 0, 50)
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		session := r.currentInvocationSession(invocationID)
		payload := append([]proto.CliOutputBatchItem(nil), batch...)

		// Persist to log first so a reattaching session can replay.
		if persistEnabled {
			ok, err := r.logs.AppendBatch(invocationID, payload)
			if err != nil || !ok {
				persistEnabled = false
			}
		}

		// Stream to the active session if one exists.
		// Output is already persisted; when the client is gone, let the
		// process keep running so a future resumeInvoke can reattach.
		if session != nil {
			if outputMode == "single" {
				for _, it := range payload {
					if err := session.SendNotification("cli.output", proto.CliOutputParams{
						InvocationID: invocationID,
						Stream:       it.Stream,
						Data:         it.Data,
						Seq:          it.Seq,
					}); err != nil {
						session = nil
					}
				}
			} else {
				if err := session.SendNotification("cli.output.batch", proto.CliOutputBatchParams{
					InvocationID: invocationID,
					Items:        payload,
				}); err != nil {
					session = nil
				}
			}
		}
		batch = batch[:0]
		return true
	}

	for {
		select {
		case it, ok := <-itemsCh:
			if !ok {
				if !flush() {
					_ = cmd.Wait()
					return
				}
				exitCode := 0
				sig := ""
				if err := cmd.Wait(); err != nil {
					if ee, ok := err.(*exec.ExitError); ok {
						exitCode = ee.ExitCode()
					} else {
						exitCode = 1
						sig = err.Error()
					}
				}
				// Fix #3: Persist cli.done so reattaching clients learn exit status.
				if r.logs != nil && persistEnabled {
					_ = r.logs.AppendDone(invocationID, exitCode, sig)
				}
				session := r.currentInvocationSession(invocationID)
				if session != nil {
					_ = session.SendNotification("cli.done", proto.CliDoneParams{
						InvocationID: invocationID,
						ExitCode:     exitCode,
						Signal:       sig,
					})
				}
				return
			}
			batch = append(batch, it)
			if len(batch) >= 50 {
					if !flush() {
						_ = cmd.Wait()
						return
					}
			}
		case <-ticker.C:
			if !flush() {
				_ = cmd.Wait()
				return
			}
		}
	}
}

func (r *extensionRunner) scanStream(wg *sync.WaitGroup, src io.Reader, stream string, out chan<- proto.CliOutputBatchItem) {
	defer wg.Done()
	scanner := bufio.NewScanner(src)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		seq := r.seq.Add(1)
		out <- proto.CliOutputBatchItem{Stream: stream, Data: scanner.Text() + "\n", Seq: seq}
	}
	if err := scanner.Err(); err != nil {
		seq := r.seq.Add(1)
		out <- proto.CliOutputBatchItem{Stream: "stderr", Data: "[stream error] " + err.Error() + "\n", Seq: seq}
	}
}

