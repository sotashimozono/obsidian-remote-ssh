package rpc

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

func TestDispatcher_RoutesByMethod(t *testing.T) {
	d := NewDispatcher()
	d.Handle("echo", func(_ context.Context, params json.RawMessage) (interface{}, *Error) {
		return map[string]json.RawMessage{"echoed": params}, nil
	})

	reply := d.Process(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"echo","params":{"hello":"world"}}`))
	var env proto.Success
	if err := json.Unmarshal(reply, &env); err != nil {
		t.Fatalf("unmarshal success: %v\n%s", err, reply)
	}
	if string(env.ID) != "1" {
		t.Errorf("id = %s, want 1", env.ID)
	}
}

func TestDispatcher_MethodNotFound(t *testing.T) {
	d := NewDispatcher()
	reply := d.Process(context.Background(), []byte(`{"jsonrpc":"2.0","id":7,"method":"missing"}`))
	if code := errorCode(t, reply); code != proto.ErrorMethodNotFound {
		t.Errorf("error code = %d, want %d", code, proto.ErrorMethodNotFound)
	}
}

func TestDispatcher_HandlerErrorsArePropagated(t *testing.T) {
	d := NewDispatcher()
	d.Handle("forbid", func(_ context.Context, _ json.RawMessage) (interface{}, *Error) {
		return nil, ErrAuthRequired()
	})
	reply := d.Process(context.Background(), []byte(`{"jsonrpc":"2.0","id":2,"method":"forbid"}`))
	if code := errorCode(t, reply); code != proto.ErrorAuthRequired {
		t.Errorf("error code = %d, want %d", code, proto.ErrorAuthRequired)
	}
}

func TestDispatcher_PanicBecomesInternalError(t *testing.T) {
	d := NewDispatcher()
	d.Handle("boom", func(_ context.Context, _ json.RawMessage) (interface{}, *Error) {
		panic("explosion in handler")
	})
	reply := d.Process(context.Background(), []byte(`{"jsonrpc":"2.0","id":3,"method":"boom"}`))
	if code := errorCode(t, reply); code != proto.ErrorInternalError {
		t.Errorf("error code = %d, want %d", code, proto.ErrorInternalError)
	}
	if !strings.Contains(string(reply), "explosion") {
		t.Errorf("error message should mention panic text:\n%s", reply)
	}
}

func TestDispatcher_MalformedJSON(t *testing.T) {
	d := NewDispatcher()
	reply := d.Process(context.Background(), []byte(`not a json doc`))
	if code := errorCode(t, reply); code != proto.ErrorParseError {
		t.Errorf("error code = %d, want %d", code, proto.ErrorParseError)
	}
}

func TestDispatcher_WrongJSONRPCVersion(t *testing.T) {
	d := NewDispatcher()
	reply := d.Process(context.Background(), []byte(`{"jsonrpc":"1.0","id":1,"method":"anything"}`))
	if code := errorCode(t, reply); code != proto.ErrorInvalidRequest {
		t.Errorf("error code = %d, want %d", code, proto.ErrorInvalidRequest)
	}
}

func TestDispatcher_NotificationReturnsNoBytes(t *testing.T) {
	d := NewDispatcher()
	called := false
	d.Handle("ping", func(_ context.Context, _ json.RawMessage) (interface{}, *Error) {
		called = true
		return nil, nil
	})
	reply := d.Process(context.Background(), []byte(`{"jsonrpc":"2.0","method":"ping"}`))
	if reply != nil {
		t.Errorf("notification produced a reply: %s", reply)
	}
	if !called {
		t.Error("handler should still be invoked for notifications")
	}
}

func TestDispatcher_NullResultIsEncodedAsNull(t *testing.T) {
	d := NewDispatcher()
	d.Handle("nothing", func(_ context.Context, _ json.RawMessage) (interface{}, *Error) {
		return nil, nil
	})
	reply := d.Process(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"nothing"}`))
	var env proto.Success
	if err := json.Unmarshal(reply, &env); err != nil {
		t.Fatal(err)
	}
	if string(env.Result) != "null" {
		t.Errorf("result = %s, want null", env.Result)
	}
}

func TestDispatcher_AttachesMetaToContext(t *testing.T) {
	d := NewDispatcher()
	var captured *proto.Meta
	var hadMeta bool
	d.Handle("inspect", func(ctx context.Context, _ json.RawMessage) (interface{}, *Error) {
		captured, hadMeta = MetaFromContext(ctx)
		return nil, nil
	})

	reply := d.Process(context.Background(), []byte(
		`{"jsonrpc":"2.0","id":1,"method":"inspect","meta":{"cid":"feedfacedeadbeef"}}`,
	))
	if reply == nil {
		t.Fatal("non-notification produced no reply")
	}
	if !hadMeta {
		t.Fatal("MetaFromContext returned ok=false; ctx was not enriched")
	}
	if captured == nil || captured.Cid != "feedfacedeadbeef" {
		t.Errorf("captured meta cid = %+v, want feedfacedeadbeef", captured)
	}
}

func TestDispatcher_AbsentMetaIsNotAttached(t *testing.T) {
	d := NewDispatcher()
	var captured *proto.Meta
	var hadMeta bool
	d.Handle("inspect", func(ctx context.Context, _ json.RawMessage) (interface{}, *Error) {
		captured, hadMeta = MetaFromContext(ctx)
		return nil, nil
	})

	d.Process(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"inspect"}`))
	if hadMeta {
		t.Errorf("MetaFromContext should be absent when wire payload has no meta; got %+v", captured)
	}
}

func TestDispatcher_Methods(t *testing.T) {
	d := NewDispatcher()
	d.Handle("a", func(context.Context, json.RawMessage) (interface{}, *Error) { return nil, nil })
	d.Handle("b", func(context.Context, json.RawMessage) (interface{}, *Error) { return nil, nil })
	got := d.Methods()
	if len(got) != 2 {
		t.Fatalf("want 2 methods, got %d: %v", len(got), got)
	}
}

// errorCode unmarshals reply as an ErrorEnvelope and returns the code.
func errorCode(t *testing.T, reply []byte) int {
	t.Helper()
	var env proto.ErrorEnvelope
	if err := json.Unmarshal(reply, &env); err != nil {
		t.Fatalf("not an error envelope: %v\n%s", err, reply)
	}
	return env.Error.Code
}
