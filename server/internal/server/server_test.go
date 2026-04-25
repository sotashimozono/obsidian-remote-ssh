package server_test

import (
	"bufio"
	"context"
	"encoding/json"
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
)

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
	srv := server.New(server.Options{
		Token:     tk,
		VaultRoot: vaultRoot,
		Version:   "test",
	})
	disp := srv.Dispatcher()
	disp.Handle("auth", handlers.Auth(tk))
	disp.Handle("server.info", handlers.ServerInfo(disp, "test", vaultRoot))
	disp.Handle("fs.stat", handlers.RequireAuth(handlers.FsStat(vaultRoot)))
	disp.Handle("fs.exists", handlers.RequireAuth(handlers.FsExists(vaultRoot)))
	disp.Handle("fs.list", handlers.RequireAuth(handlers.FsList(vaultRoot)))
	disp.Handle("fs.readText", handlers.RequireAuth(handlers.FsReadText(vaultRoot)))
	disp.Handle("fs.readBinary", handlers.RequireAuth(handlers.FsReadBinary(vaultRoot)))

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
		"auth", "fs.exists", "fs.list", "fs.readBinary",
		"fs.readText", "fs.stat", "server.info",
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
