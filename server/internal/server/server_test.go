package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/auth"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/handlers"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/watcher"
)

// watcherCleaner adapts the package's vault watcher to
// server.SubscriptionCleaner — see the equivalent type in
// cmd/obsidian-remote-server/main.go for the production wiring.
type watcherCleaner struct{ w *watcher.Watcher }

func (c watcherCleaner) CleanupSubscriptions(ids []string) {
	for _, id := range ids {
		c.w.Unsubscribe(id)
	}
}

// testServer spins up a listening Server on 127.0.0.1:<random>, wires
// the full handler set (matching main.go), and tears everything down
// on Cleanup. It returns a helper that dials fresh framed connections.
type testServer struct {
	addr      string
	token     auth.Token
	vaultRoot string
}

func startTestServer(t *testing.T) *testServer {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	tk, err := auth.Generate()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	vaultRoot := t.TempDir()
	w, err := watcher.New(vaultRoot)
	if err != nil {
		t.Fatalf("watcher: %v", err)
	}
	t.Cleanup(func() { _ = w.Close() })

	srv := server.New(server.Options{
		Token:               tk,
		VaultRoot:           vaultRoot,
		Version:             "test",
		SubscriptionCleaner: watcherCleaner{w},
	})
	disp := srv.Dispatcher()
	disp.Handle("auth", handlers.Auth(tk))
	disp.Handle("server.info", handlers.ServerInfo(disp, "test", vaultRoot))
	disp.Handle("fs.stat", handlers.RequireAuth(handlers.FsStat(vaultRoot)))
	disp.Handle("fs.exists", handlers.RequireAuth(handlers.FsExists(vaultRoot)))
	disp.Handle("fs.list", handlers.RequireAuth(handlers.FsList(vaultRoot)))
	disp.Handle("fs.readText", handlers.RequireAuth(handlers.FsReadText(vaultRoot)))
	disp.Handle("fs.readBinary", handlers.RequireAuth(handlers.FsReadBinary(vaultRoot)))
	disp.Handle("fs.write", handlers.RequireAuth(handlers.FsWrite(vaultRoot, nil, nil)))
	disp.Handle("fs.writeBinary", handlers.RequireAuth(handlers.FsWriteBinary(vaultRoot, nil, nil)))
	disp.Handle("fs.append", handlers.RequireAuth(handlers.FsAppend(vaultRoot)))
	disp.Handle("fs.appendBinary", handlers.RequireAuth(handlers.FsAppendBinary(vaultRoot)))
	disp.Handle("fs.mkdir", handlers.RequireAuth(handlers.FsMkdir(vaultRoot)))
	disp.Handle("fs.remove", handlers.RequireAuth(handlers.FsRemove(vaultRoot, nil)))
	disp.Handle("fs.rmdir", handlers.RequireAuth(handlers.FsRmdir(vaultRoot)))
	disp.Handle("fs.rename", handlers.RequireAuth(handlers.FsRename(vaultRoot, nil)))
	disp.Handle("fs.copy", handlers.RequireAuth(handlers.FsCopy(vaultRoot, nil)))
	disp.Handle("fs.trashLocal", handlers.RequireAuth(handlers.FsTrashLocal(vaultRoot)))
	disp.Handle("fs.watch", handlers.RequireAuth(handlers.FsWatch(w, nil)))
	disp.Handle("fs.unwatch", handlers.RequireAuth(handlers.FsUnwatch(w)))

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = srv.Serve(ctx, listener)
	}()
	t.Cleanup(func() {
		cancel()
		_ = listener.Close()
		wg.Wait()
	})

	return &testServer{addr: listener.Addr().String(), token: tk, vaultRoot: vaultRoot}
}

// client represents one JSON-RPC session over a TCP loopback.
type client struct {
	conn   net.Conn
	reader *bufio.Reader
	nextID int
}

func (ts *testServer) dial(t *testing.T) *client {
	t.Helper()
	conn, err := net.DialTimeout("tcp", ts.addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &client{conn: conn, reader: bufio.NewReader(conn)}
}

func (c *client) call(t *testing.T, method string, params interface{}) (json.RawMessage, *proto.ErrorObject) {
	t.Helper()
	c.nextID++
	id := c.nextID
	paramsBytes, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	if params == nil {
		paramsBytes = json.RawMessage("null")
	}
	reqBytes, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  json.RawMessage(paramsBytes),
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if err := rpc.WriteFrame(c.conn, reqBytes); err != nil {
		t.Fatalf("write frame: %v", err)
	}
	reply, err := rpc.ReadFrame(c.reader, 0)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	// Decode into a shape that accepts either success or error.
	var env struct {
		ID     json.RawMessage     `json:"id"`
		Result json.RawMessage     `json:"result,omitempty"`
		Error  *proto.ErrorObject  `json:"error,omitempty"`
	}
	if err := json.Unmarshal(reply, &env); err != nil {
		t.Fatalf("unmarshal reply: %v\n%s", err, reply)
	}
	return env.Result, env.Error
}

// callNoFatal mirrors `call` but surfaces transport / decoding errors
// in the returned ErrorObject instead of failing the test directly.
// Useful from goroutines that race with test teardown — a t.Fatalf
// from a side goroutine would mark the test failed even though the
// only "error" is the listener being closed at exit time.
func (c *client) callNoFatal(method string, params interface{}) (json.RawMessage, *proto.ErrorObject) {
	c.nextID++
	id := c.nextID
	paramsBytes, err := json.Marshal(params)
	if err != nil {
		return nil, &proto.ErrorObject{Code: proto.ErrorInternalError, Message: "marshal params: " + err.Error()}
	}
	if params == nil {
		paramsBytes = json.RawMessage("null")
	}
	reqBytes, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  json.RawMessage(paramsBytes),
	})
	if err != nil {
		return nil, &proto.ErrorObject{Code: proto.ErrorInternalError, Message: "marshal request: " + err.Error()}
	}
	if err := rpc.WriteFrame(c.conn, reqBytes); err != nil {
		return nil, &proto.ErrorObject{Code: proto.ErrorInternalError, Message: "write frame: " + err.Error()}
	}
	reply, err := rpc.ReadFrame(c.reader, 0)
	if err != nil {
		return nil, &proto.ErrorObject{Code: proto.ErrorInternalError, Message: "read frame: " + err.Error()}
	}
	var env struct {
		ID     json.RawMessage    `json:"id"`
		Result json.RawMessage    `json:"result,omitempty"`
		Error  *proto.ErrorObject `json:"error,omitempty"`
	}
	if err := json.Unmarshal(reply, &env); err != nil {
		return nil, &proto.ErrorObject{Code: proto.ErrorInternalError, Message: "unmarshal reply: " + err.Error()}
	}
	return env.Result, env.Error
}

func TestServer_AuthInvalidToken(t *testing.T) {
	ts := startTestServer(t)
	c := ts.dial(t)

	_, errObj := c.call(t, "auth", map[string]string{"token": "nope"})
	if errObj == nil || errObj.Code != proto.ErrorAuthInvalid {
		t.Fatalf("want AuthInvalid, got %+v", errObj)
	}
}

func TestServer_MethodNotFound(t *testing.T) {
	ts := startTestServer(t)
	c := ts.dial(t)

	_, errObj := c.call(t, "fs.nope", nil)
	if errObj == nil || errObj.Code != proto.ErrorMethodNotFound {
		t.Fatalf("want MethodNotFound, got %+v", errObj)
	}
}

func TestServer_FsOpsRequireAuth(t *testing.T) {
	ts := startTestServer(t)
	c := ts.dial(t)

	// Pre-auth: fs.list should be rejected with AuthRequired, not
	// silently return the vault contents.
	_, errObj := c.call(t, "fs.list", map[string]string{"path": ""})
	if errObj == nil || errObj.Code != proto.ErrorAuthRequired {
		t.Fatalf("want AuthRequired before auth, got %+v", errObj)
	}
}

func TestServer_ReadPipeline(t *testing.T) {
	ts := startTestServer(t)

	// Seed a small vault so fs.list / fs.readText have something
	// concrete to observe.
	mustWrite(t, filepath.Join(ts.vaultRoot, "note.md"), []byte("# hello"))
	mustWrite(t, filepath.Join(ts.vaultRoot, "docs", "a.md"), []byte("alpha"))

	c := ts.dial(t)

	// Step 1: auth.
	if _, errObj := c.call(t, "auth", map[string]string{"token": string(ts.token)}); errObj != nil {
		t.Fatalf("auth: %+v", errObj)
	}

	// Step 2: fs.stat root.
	result, errObj := c.call(t, "fs.stat", map[string]string{"path": ""})
	if errObj != nil {
		t.Fatalf("fs.stat(root): %+v", errObj)
	}
	var stat proto.Stat
	if err := json.Unmarshal(result, &stat); err != nil {
		t.Fatalf("unmarshal stat: %v", err)
	}
	if stat.Type != proto.EntryTypeFolder {
		t.Errorf("root stat type = %q, want folder", stat.Type)
	}

	// Step 3: fs.list root — expect our seeded file + dir.
	result, errObj = c.call(t, "fs.list", map[string]string{"path": ""})
	if errObj != nil {
		t.Fatalf("fs.list: %+v", errObj)
	}
	var list proto.ListResult
	if err := json.Unmarshal(result, &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	names := map[string]proto.EntryType{}
	for _, e := range list.Entries {
		names[e.Name] = e.Type
	}
	if names["note.md"] != proto.EntryTypeFile {
		t.Errorf("note.md missing or wrong type; got map = %v", names)
	}
	if names["docs"] != proto.EntryTypeFolder {
		t.Errorf("docs missing or wrong type; got map = %v", names)
	}

	// Step 4: fs.readText.
	result, errObj = c.call(t, "fs.readText", map[string]string{"path": "note.md"})
	if errObj != nil {
		t.Fatalf("fs.readText: %+v", errObj)
	}
	var readText proto.ReadTextResult
	if err := json.Unmarshal(result, &readText); err != nil {
		t.Fatalf("unmarshal readText: %v", err)
	}
	if readText.Content != "# hello" {
		t.Errorf("content = %q, want %q", readText.Content, "# hello")
	}
	if readText.Encoding != "utf8" {
		t.Errorf("encoding = %q, want utf8", readText.Encoding)
	}

	// Step 5: fs.readText on a missing file should fail cleanly.
	_, errObj = c.call(t, "fs.readText", map[string]string{"path": "missing.md"})
	if errObj == nil || errObj.Code != proto.ErrorFileNotFound {
		t.Fatalf("missing read: want FileNotFound, got %+v", errObj)
	}

	// Step 6: path escape is refused with PathOutsideVault.
	_, errObj = c.call(t, "fs.stat", map[string]string{"path": "../../etc/passwd"})
	if errObj == nil || errObj.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("escape: want PathOutsideVault, got %+v", errObj)
	}
}

func mustWrite(t *testing.T, abs string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestServer_WritePipeline(t *testing.T) {
	ts := startTestServer(t)
	c := ts.dial(t)

	// Authenticate.
	if _, errObj := c.call(t, "auth", map[string]string{"token": string(ts.token)}); errObj != nil {
		t.Fatalf("auth: %+v", errObj)
	}

	// Step 1: fs.write creates a note (parents auto-created).
	_, errObj := c.call(t, "fs.write", map[string]string{
		"path":    "docs/note.md",
		"content": "first",
	})
	if errObj != nil {
		t.Fatalf("fs.write: %+v", errObj)
	}
	if data, err := os.ReadFile(filepath.Join(ts.vaultRoot, "docs", "note.md")); err != nil || string(data) != "first" {
		t.Fatalf("disk after write: data=%q err=%v", data, err)
	}

	// Step 2: fs.append adds more bytes.
	_, errObj = c.call(t, "fs.append", map[string]string{
		"path":    "docs/note.md",
		"content": "-second",
	})
	if errObj != nil {
		t.Fatalf("fs.append: %+v", errObj)
	}
	data, _ := os.ReadFile(filepath.Join(ts.vaultRoot, "docs", "note.md"))
	if string(data) != "first-second" {
		t.Errorf("after append disk = %q, want %q", data, "first-second")
	}

	// Step 3: fs.rename into a nested directory (auto-create parent).
	_, errObj = c.call(t, "fs.rename", map[string]string{
		"oldPath": "docs/note.md",
		"newPath": "archive/2026/note.md",
	})
	if errObj != nil {
		t.Fatalf("fs.rename: %+v", errObj)
	}
	if _, err := os.Stat(filepath.Join(ts.vaultRoot, "archive", "2026", "note.md")); err != nil {
		t.Fatalf("renamed target missing: %v", err)
	}

	// Step 4: fs.copy → fs.trashLocal on the copy.
	_, errObj = c.call(t, "fs.copy", map[string]string{
		"srcPath":  "archive/2026/note.md",
		"destPath": "latest.md",
	})
	if errObj != nil {
		t.Fatalf("fs.copy: %+v", errObj)
	}
	_, errObj = c.call(t, "fs.trashLocal", map[string]string{"path": "latest.md"})
	if errObj != nil {
		t.Fatalf("fs.trashLocal: %+v", errObj)
	}
	if _, err := os.Stat(filepath.Join(ts.vaultRoot, "latest.md")); !os.IsNotExist(err) {
		t.Error("latest.md should be gone after trashLocal")
	}
	if _, err := os.Stat(filepath.Join(ts.vaultRoot, ".trash", "latest.md")); err != nil {
		t.Errorf(".trash/latest.md missing: %v", err)
	}

	// Step 5: fs.mkdir (recursive) then fs.rmdir (recursive) round trip.
	if _, errObj := c.call(t, "fs.mkdir", map[string]any{
		"path": "scratch/a/b", "recursive": true,
	}); errObj != nil {
		t.Fatalf("fs.mkdir: %+v", errObj)
	}
	if _, errObj := c.call(t, "fs.rmdir", map[string]any{
		"path": "scratch", "recursive": true,
	}); errObj != nil {
		t.Fatalf("fs.rmdir: %+v", errObj)
	}
	if _, err := os.Stat(filepath.Join(ts.vaultRoot, "scratch")); !os.IsNotExist(err) {
		t.Error("scratch should be gone")
	}

	// Step 6: fs.remove on a file, then confirm missing.
	mustWrite(t, filepath.Join(ts.vaultRoot, "doomed.md"), []byte("bye"))
	if _, errObj := c.call(t, "fs.remove", map[string]string{"path": "doomed.md"}); errObj != nil {
		t.Fatalf("fs.remove: %+v", errObj)
	}
	if _, err := os.Stat(filepath.Join(ts.vaultRoot, "doomed.md")); !os.IsNotExist(err) {
		t.Error("doomed.md should be gone")
	}
}

func TestServer_WritePreconditionGuard(t *testing.T) {
	ts := startTestServer(t)
	c := ts.dial(t)
	if _, errObj := c.call(t, "auth", map[string]string{"token": string(ts.token)}); errObj != nil {
		t.Fatalf("auth: %+v", errObj)
	}

	// Seed a file and capture its mtime.
	mustWrite(t, filepath.Join(ts.vaultRoot, "note.md"), []byte("seed"))
	statRes, errObj := c.call(t, "fs.stat", map[string]string{"path": "note.md"})
	if errObj != nil {
		t.Fatalf("fs.stat: %+v", errObj)
	}
	var s proto.Stat
	if err := json.Unmarshal(statRes, &s); err != nil {
		t.Fatalf("unmarshal stat: %v", err)
	}

	// Matching expectedMtime: write succeeds.
	if _, errObj := c.call(t, "fs.write", map[string]any{
		"path":          "note.md",
		"content":       "ok",
		"expectedMtime": s.Mtime,
	}); errObj != nil {
		t.Fatalf("fs.write (matching precondition): %+v", errObj)
	}
	if data, _ := os.ReadFile(filepath.Join(ts.vaultRoot, "note.md")); string(data) != "ok" {
		t.Errorf("disk = %q, want %q", data, "ok")
	}

	// Mismatched expectedMtime: write rejected, disk unchanged.
	_, errObj = c.call(t, "fs.write", map[string]any{
		"path":          "note.md",
		"content":       "clobber",
		"expectedMtime": 1, // deliberately stale
	})
	if errObj == nil || errObj.Code != proto.ErrorPreconditionFailed {
		t.Fatalf("want PreconditionFailed, got %+v", errObj)
	}
	if data, _ := os.ReadFile(filepath.Join(ts.vaultRoot, "note.md")); string(data) != "ok" {
		t.Errorf("disk was clobbered despite precondition: %q", data)
	}
}

func TestServer_AuthThenServerInfo(t *testing.T) {
	ts := startTestServer(t)
	c := ts.dial(t)

	// Step 1: auth with the correct token.
	result, errObj := c.call(t, "auth", map[string]string{"token": string(ts.token)})
	if errObj != nil {
		t.Fatalf("auth: %+v", errObj)
	}
	var authOK proto.AuthResult
	if err := json.Unmarshal(result, &authOK); err != nil {
		t.Fatalf("unmarshal auth result: %v", err)
	}
	if !authOK.OK {
		t.Error("auth should have returned ok=true")
	}

	// Step 2: server.info responds on the same session.
	result, errObj = c.call(t, "server.info", map[string]any{})
	if errObj != nil {
		t.Fatalf("server.info: %+v", errObj)
	}
	var info proto.ServerInfo
	if err := json.Unmarshal(result, &info); err != nil {
		t.Fatalf("unmarshal info: %v", err)
	}
	if info.Version != "test" {
		t.Errorf("Version = %q, want test", info.Version)
	}
	if info.ProtocolVersion != proto.ProtocolVersion {
		t.Errorf("ProtocolVersion = %d, want %d", info.ProtocolVersion, proto.ProtocolVersion)
	}
	wantCaps := []string{
		"auth",
		"fs.append", "fs.appendBinary", "fs.copy",
		"fs.exists", "fs.list", "fs.mkdir",
		"fs.readBinary", "fs.readText",
		"fs.remove", "fs.rename", "fs.rmdir",
		"fs.stat", "fs.trashLocal",
		"fs.unwatch", "fs.watch",
		"fs.write", "fs.writeBinary",
		"server.info",
	}
	got := append([]string(nil), info.Capabilities...)
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(wantCaps, ",") {
		t.Errorf("capabilities = %v, want %v", got, wantCaps)
	}
}

func TestServer_GracefulEOF(t *testing.T) {
	ts := startTestServer(t)
	conn, err := net.Dial("tcp", ts.addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// Closing immediately should not crash the server; subsequent
	// dials must still succeed.
	_ = conn.Close()

	c := ts.dial(t)
	_, errObj := c.call(t, "auth", map[string]string{"token": string(ts.token)})
	if errObj != nil {
		t.Fatalf("auth after prior close: %+v", errObj)
	}
}

// TestServer_WatchPipeline confirms the daemon's fs.watch surface
// end-to-end: a "watcher" client subscribes to the vault root, a
// separate "writer" client writes a file through fs.write, and the
// watcher receives a matching `fs.changed` notification on its
// socket.
//
// Two connections keep the watcher's read loop from racing the
// fs.write reply.
func TestServer_WatchPipeline(t *testing.T) {
	ts := startTestServer(t)

	// Watcher connection.
	w := ts.dial(t)
	if _, errObj := w.call(t, "auth", map[string]string{"token": string(ts.token)}); errObj != nil {
		t.Fatalf("watcher auth: %+v", errObj)
	}
	subRaw, errObj := w.call(t, "fs.watch", map[string]any{"path": "", "recursive": true})
	if errObj != nil {
		t.Fatalf("fs.watch: %+v", errObj)
	}
	var sub proto.WatchResult
	if err := json.Unmarshal(subRaw, &sub); err != nil {
		t.Fatalf("unmarshal watch result: %v", err)
	}
	if sub.SubscriptionID == "" {
		t.Fatal("fs.watch returned an empty subscription id")
	}

	// Writer connection: a separate session does the file write so
	// the watcher's reader never has to interleave the fs.write reply
	// with the fs.changed notification.
	wr := ts.dial(t)
	if _, errObj := wr.call(t, "auth", map[string]string{"token": string(ts.token)}); errObj != nil {
		t.Fatalf("writer auth: %+v", errObj)
	}
	// The writer goroutine has its own short-lived view of `t`; using
	// `t.Fatalf` from here would race with the main test ending and
	// cause a "use of closed network connection" failure when the
	// teardown closes the listener before the fs.write reply arrives.
	// We just signal completion and surface any non-nil error explicitly
	// when the main test is done with the watcher.
	writerDone := make(chan error, 1)
	go func() {
		// Tiny delay so the watcher reader is blocked on its
		// next ReadFrame when the notification lands.
		time.Sleep(50 * time.Millisecond)
		_, errObj := wr.callNoFatal("fs.write", map[string]any{
			"path":    "watched.md",
			"content": "fresh",
		})
		if errObj != nil {
			writerDone <- fmt.Errorf("writer fs.write: %+v", errObj)
		} else {
			writerDone <- nil
		}
	}()

	// atomicWriteFile creates a tmp file first and then renames it to
	// the target, so fsnotify will fire several events in sequence
	// (create + modify on the tmp, then a rename + create matching
	// the final path). We just need to find one fs.changed where the
	// path matches our target.
	deadline := time.Now().Add(3 * time.Second)
	gotChange := false
	for time.Now().Before(deadline) && !gotChange {
		_ = w.conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		body, err := rpc.ReadFrame(w.reader, 0)
		if err != nil {
			continue // read deadline; try again
		}
		var env struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			continue
		}
		if env.Method != "fs.changed" {
			continue
		}
		var p proto.FsChangedParams
		if err := json.Unmarshal(env.Params, &p); err != nil {
			t.Fatalf("unmarshal fs.changed params: %v", err)
		}
		if p.SubscriptionID != sub.SubscriptionID {
			t.Errorf("subscriptionId = %q, want %q", p.SubscriptionID, sub.SubscriptionID)
		}
		if p.Path == "watched.md" {
			if p.Event != proto.FsChangeEventCreated && p.Event != proto.FsChangeEventModified {
				t.Errorf("event = %q, want created or modified", p.Event)
			}
			gotChange = true
		}
		// Other events (tmp file artefacts) just get drained — keep reading.
	}
	_ = w.conn.SetReadDeadline(time.Time{})
	if !gotChange {
		t.Fatal("never received an fs.changed notification for watched.md within the deadline")
	}

	if _, errObj := w.call(t, "fs.unwatch", map[string]string{"subscriptionId": sub.SubscriptionID}); errObj != nil {
		t.Fatalf("fs.unwatch: %+v", errObj)
	}

	// Wait for the writer goroutine before returning so its
	// reply-read finishes before the test server's listener closes.
	// A bounded wait is enough: the write itself already succeeded by
	// the time we observed the fs.changed notification.
	select {
	case err := <-writerDone:
		if err != nil {
			t.Errorf("%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Errorf("writer goroutine did not finish in time")
	}
}
