package rpc

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReadFrame_Roundtrip(t *testing.T) {
	var buf bytes.Buffer
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"auth","params":{"token":"abc"}}`)
	if err := WriteFrame(&buf, body); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(&buf)
	got, err := ReadFrame(r, 0)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("body mismatch:\n  got  %q\n  want %q", got, body)
	}
}

func TestReadFrame_MultipleInSequence(t *testing.T) {
	var buf bytes.Buffer
	bodies := [][]byte{
		[]byte(`{"a":1}`),
		[]byte(`{"b":2}`),
		[]byte(`{"c":"payload with\nembedded\r\nwhitespace"}`),
	}
	for _, b := range bodies {
		if err := WriteFrame(&buf, b); err != nil {
			t.Fatal(err)
		}
	}
	r := bufio.NewReader(&buf)
	for i, want := range bodies {
		got, err := ReadFrame(r, 0)
		if err != nil {
			t.Fatalf("ReadFrame[%d]: %v", i, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("frame[%d] mismatch:\n  got  %q\n  want %q", i, got, want)
		}
	}
}

func TestReadFrame_CleanEOF(t *testing.T) {
	r := bufio.NewReader(strings.NewReader(""))
	_, err := ReadFrame(r, 0)
	if !errors.Is(err, io.EOF) {
		t.Errorf("want io.EOF for empty stream, got %v", err)
	}
}

func TestReadFrame_MissingContentLength(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("X-Foo: bar\r\n\r\n"))
	_, err := ReadFrame(r, 0)
	if err == nil {
		t.Fatal("expected error for missing Content-Length, got nil")
	}
	if !strings.Contains(err.Error(), "Content-Length") {
		t.Errorf("error should mention Content-Length, got %v", err)
	}
}

func TestReadFrame_InvalidContentLength(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("Content-Length: not-a-number\r\n\r\n"))
	_, err := ReadFrame(r, 0)
	if err == nil || !strings.Contains(err.Error(), "invalid Content-Length") {
		t.Errorf("want invalid Content-Length error, got %v", err)
	}
}

func TestReadFrame_IgnoresUnknownHeader(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("X-Forwarded-For: 1.2.3.4\r\nContent-Length: 2\r\n\r\nok"))
	got, err := ReadFrame(r, 0)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ok" {
		t.Errorf("body = %q, want %q", got, "ok")
	}
}

func TestReadFrame_MessageTooLarge(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("Content-Length: 5000\r\n\r\nhello"))
	_, err := ReadFrame(r, 100)
	if !errors.Is(err, ErrMessageTooLarge) {
		t.Errorf("want ErrMessageTooLarge, got %v", err)
	}
}

func TestReadFrame_ToleratesBareLF(t *testing.T) {
	// Some lenient clients emit \n instead of \r\n.
	r := bufio.NewReader(strings.NewReader("Content-Length: 2\n\nok"))
	got, err := ReadFrame(r, 0)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ok" {
		t.Errorf("body = %q, want %q", got, "ok")
	}
}

func TestWriteFrame_Bytes(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, []byte(`{"x":1}`)); err != nil {
		t.Fatal(err)
	}
	want := "Content-Length: 7\r\n\r\n{\"x\":1}"
	if buf.String() != want {
		t.Errorf("output = %q, want %q", buf.String(), want)
	}
}
