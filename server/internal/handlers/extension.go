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
// startedAt is the registration time, used to pick the oldest orphan
// when the invocation pool is full and a slot must be reclaimed.
// doneReason is set when the daemon itself terminated the process
// (lazy reap or an explicit extension.kill); it stays empty on a
// natural exit or crash so reattaching clients can tell them apart.
type activeInvocation struct {
	session    *server.Session
	stop       func() error
	outputMode string
	startedAt  time.Time
	doneReason string
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

		acquired := false
		for !acquired {
			select {
			case r.slots <- struct{}{}:
				acquired = true
			case <-ctx.Done():
				return nil, rpc.ErrInternal("extension.invoke: context canceled")
			default:
				// Pool full. Reap the oldest orphaned invocation (a
				// dropped client whose process still runs) to free a
				// slot, then block until a slot frees or the caller
				// cancels. Nothing dies while the pool is not full.
				r.reapOldestOrphan()
				select {
				case r.slots <- struct{}{}:
					acquired = true
				case <-ctx.Done():
					return nil, rpc.ErrInternal("extension.invoke: context canceled")
				}
			}
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

		setProcessGroup(cmd)
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
			return killProcessGroup(cmd)
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
			Reason:       done.Reason,
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

		r.markDoneReason(p.InvocationID, "killed")
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
	r.active[invocationID] = activeInvocation{session: session, outputMode: outputMode, stop: stop, startedAt: time.Now()}
	r.attachOnClose(invocationID, session)
}

// attachOnClose detaches the invocation from session when the
// connection dies, so the process becomes an orphan that a future
// resumeInvoke can rebind or the lazy reaper can reclaim. Must be
// called with r.mu held.
func (r *extensionRunner) attachOnClose(invocationID string, session *server.Session) {
	if session == nil {
		return
	}
	session.OnClose(func() { r.clearInvocationSessionIf(invocationID, session) })
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
	r.attachOnClose(invocationID, session)
	return inv, true
}

// clearInvocationSessionIf nils the registered session only when it still
// points at session. A concurrent resumeInvoke may have rebound a fresh
// session by the time a stale send fails; clearing unconditionally would
// detach the new client.
func (r *extensionRunner) clearInvocationSessionIf(invocationID string, session *server.Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	inv, ok := r.active[invocationID]
	if !ok || inv.session != session {
		return
	}
	inv.session = nil
	r.active[invocationID] = inv
}

// markDoneReason records why the daemon terminated the invocation.
// First write wins: a race between the lazy reaper and an explicit
// extension.kill must not flip-flop the reason sent in cli.done.
func (r *extensionRunner) markDoneReason(invocationID, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	inv, ok := r.active[invocationID]
	if !ok || inv.doneReason != "" {
		return
	}
	inv.doneReason = reason
	r.active[invocationID] = inv
}

// reapOldestOrphan kills the oldest invocation with no attached session
// that has not already been marked for reaping, freeing its slot for a
// new invoke. The kill is asynchronous: the slot actually frees when
// streamProcess sees the pipes hit EOF and runs releaseSlot. Skipping
// reaped entries keeps a concurrent second reaper from re-killing the
// same process while it awaits EOF teardown. Returns false when no
// reapable orphan exists, so the caller can block on a slot instead of
// spinning.
func (r *extensionRunner) reapOldestOrphan() bool {
	r.mu.Lock()
	var oldestID string
	var oldestStart time.Time
	for id, inv := range r.active {
		if inv.session != nil || inv.doneReason == "reaped" {
			continue
		}
		if oldestID == "" || inv.startedAt.Before(oldestStart) {
			oldestID = id
			oldestStart = inv.startedAt
		}
	}
	// Selection, orphan re-check, doneReason mark, and stop capture all
	// happen under one lock so a concurrent resumeInvoke rebind cannot
	// slip between selection and kill and turn a live invocation into
	// a reap victim. Only the kill itself runs after the lock.
	var stop func() error
	if oldestID != "" {
		if inv, ok := r.active[oldestID]; ok && inv.session == nil && inv.doneReason == "" {
			inv.doneReason = "reaped"
			r.active[oldestID] = inv
			stop = inv.stop
		}
	}
	r.mu.Unlock()
	if stop == nil {
		return false
	}
	_ = stop()
	return true
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

		// Stream to the active session if one exists. On send failure the
		// client is gone: clear the registered session so the invocation
		// becomes an orphan that a future resumeInvoke can rebind or the
		// lazy reaper (reapOldestOrphan) can reclaim when the pool fills.
		// Output is already persisted for a future resume.
		if session != nil {
			if outputMode == "single" {
				for _, it := range payload {
					if err := session.SendNotification("cli.output", proto.CliOutputParams{
						InvocationID: invocationID,
						Stream:       it.Stream,
						Data:         it.Data,
						Seq:          it.Seq,
					}); err != nil {
						r.clearInvocationSessionIf(invocationID, session)
						session = nil
						break
					}
				}
			} else {
				if err := session.SendNotification("cli.output.batch", proto.CliOutputBatchParams{
					InvocationID: invocationID,
					Items:        payload,
				}); err != nil {
					r.clearInvocationSessionIf(invocationID, session)
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
				reason := ""
				if inv, ok := r.lookupInvocation(invocationID); ok {
					reason = inv.doneReason
				}
				// Fix #3: Persist cli.done so reattaching clients learn exit status.
				if r.logs != nil && persistEnabled {
					_ = r.logs.AppendDone(invocationID, exitCode, sig, reason)
				}
				session := r.currentInvocationSession(invocationID)
				if session != nil {
					_ = session.SendNotification("cli.done", proto.CliDoneParams{
						InvocationID: invocationID,
						ExitCode:     exitCode,
						Signal:       sig,
						Reason:       reason,
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
