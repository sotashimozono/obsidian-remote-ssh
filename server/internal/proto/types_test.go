package proto

import (
	"encoding/json"
	"strings"
	"testing"
)

// The wire shape of Meta is the contract that lets the TS plugin and
// the Go daemon thread a correlation id end-to-end. These tests pin
// (a) round-trip equivalence, (b) `omitempty` so a zero-valued Meta
// stays off the wire, and (c) backwards compatibility with payloads
// that pre-date the field.

func TestRequest_MetaRoundTrip(t *testing.T) {
	in := Request{
		JSONRPC: JSONRPCVersion,
		ID:      json.RawMessage(`1`),
		Method:  "fs.write",
		Params:  json.RawMessage(`{"path":"a.md","content":"hi"}`),
		Meta:    &Meta{Cid: "feedfacedeadbeef"},
	}
	wire, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(wire), `"meta":{"cid":"feedfacedeadbeef"}`) {
		t.Errorf("expected meta on the wire, got: %s", wire)
	}

	var out Request
	if err := json.Unmarshal(wire, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Meta == nil || out.Meta.Cid != "feedfacedeadbeef" {
		t.Errorf("round-trip meta = %+v, want cid=feedfacedeadbeef", out.Meta)
	}
}

func TestRequest_NoMetaOmittedFromWire(t *testing.T) {
	in := Request{
		JSONRPC: JSONRPCVersion,
		ID:      json.RawMessage(`1`),
		Method:  "fs.write",
		Params:  json.RawMessage(`{}`),
	}
	wire, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(wire), "meta") {
		t.Errorf("nil Meta must not appear on the wire, got: %s", wire)
	}
}

func TestRequest_AcceptsLegacyPayloadWithoutMeta(t *testing.T) {
	// A pre-meta client wire payload — must still parse cleanly so a
	// new daemon stays compatible with old plugins.
	wire := []byte(`{"jsonrpc":"2.0","id":1,"method":"fs.stat","params":{"path":"a.md"}}`)
	var out Request
	if err := json.Unmarshal(wire, &out); err != nil {
		t.Fatalf("unmarshal legacy payload: %v", err)
	}
	if out.Meta != nil {
		t.Errorf("Meta should be nil when absent on the wire, got %+v", out.Meta)
	}
	if out.Method != "fs.stat" {
		t.Errorf("method = %q", out.Method)
	}
}

func TestNotification_MetaRoundTrip(t *testing.T) {
	in := Notification{
		JSONRPC: JSONRPCVersion,
		Method:  "fs.changed",
		Params:  json.RawMessage(`{"subscriptionId":"s","path":"a.md","event":"modified"}`),
		Meta:    &Meta{Cid: "abc123"},
	}
	wire, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(wire), `"meta":{"cid":"abc123"}`) {
		t.Errorf("expected meta on the wire, got: %s", wire)
	}

	var out Notification
	if err := json.Unmarshal(wire, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Meta == nil || out.Meta.Cid != "abc123" {
		t.Errorf("round-trip meta = %+v, want cid=abc123", out.Meta)
	}
}

func TestNotification_NoMetaOmittedFromWire(t *testing.T) {
	in := Notification{
		JSONRPC: JSONRPCVersion,
		Method:  "fs.changed",
		Params:  json.RawMessage(`{}`),
	}
	wire, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(wire), "meta") {
		t.Errorf("nil Meta must not appear on the wire, got: %s", wire)
	}
}

func TestMeta_EmptyCidOmittedFromWire(t *testing.T) {
	wire, err := json.Marshal(Meta{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(wire) != "{}" {
		t.Errorf("empty Meta should marshal to {}, got: %s", wire)
	}
}
