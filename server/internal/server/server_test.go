package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
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
// the auth + server.info handlers, and tears everything down on
// Cleanup. It returns a helper that dials fresh framed connections.
type testServer struct {
	addr  string
	token auth.Token
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

	srv := server.New(server.Options{
		Token:     tk,
		VaultRoot: t.TempDir(),
		Version:   "test",
	})
	disp := srv.Dispatcher()
	disp.Handle("auth", handlers.Auth(tk))
	disp.Handle("server.info", handlers.ServerInfo(disp, "test", srv.Options().VaultRoot))

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

	return &testServer{addr: listener.Addr().String(), token: tk}
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
	wantCaps := []string{"auth", "server.info"}
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
