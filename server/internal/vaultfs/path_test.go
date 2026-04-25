package vaultfs

import (
	"errors"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolve_Happy(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "srv", "vault")

	cases := map[string]string{
		"":                    root,
		"/":                   root,
		"a.md":                filepath.Join(root, "a.md"),
		"docs/sub/a.md":       filepath.Join(root, "docs", "sub", "a.md"),
		// "." is valid — filepath.IsLocal accepts it.
		".":                   root,
		// A trailing slash is fine after Join cleans it.
		"docs/":               filepath.Join(root, "docs"),
	}
	for in, want := range cases {
		got, err := Resolve(root, in)
		if err != nil {
			t.Errorf("Resolve(%q): unexpected error %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("Resolve(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolve_RejectsAbsolute(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "srv", "vault")
	inputs := []string{
		"/etc/passwd",
		"/tmp/evil",
	}
	for _, in := range inputs {
		_, err := Resolve(root, in)
		if !errors.Is(err, ErrOutsideVault) {
			t.Errorf("Resolve(%q): want ErrOutsideVault, got %v", in, err)
		}
	}
}

func TestResolve_RejectsParentEscape(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "srv", "vault")
	inputs := []string{
		"../outside",
		"..",
		"docs/../../etc",
		"a/b/../../../c",
	}
	for _, in := range inputs {
		_, err := Resolve(root, in)
		if !errors.Is(err, ErrOutsideVault) {
			t.Errorf("Resolve(%q): want ErrOutsideVault, got %v", in, err)
		}
	}
}

func TestResolve_AcceptsInnerDotDot(t *testing.T) {
	// An internal ".." that doesn't escape the root should resolve to
	// a path that's still under root. filepath.IsLocal accepts this.
	root := filepath.Join(string(filepath.Separator), "srv", "vault")
	got, err := Resolve(root, "docs/sub/../other.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := filepath.Join(root, "docs", "other.md")
	if got != want {
		t.Errorf("Resolve cleaned to %q, want %q", got, want)
	}
}

func TestResolve_RejectsWindowsReservedNames(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("reserved device names are a Windows-only concern")
	}
	// Only the bare reserved names are guaranteed to be rejected by
	// filepath.IsLocal across Go versions. Windows itself also treats
	// e.g. "aux.txt" as the AUX device, but the standard library does
	// not consistently flag the suffixed form, so we don't assert on it.
	root := "C:\\vault"
	for _, in := range []string{"NUL", "CON", "PRN", "AUX", "COM1", "LPT1"} {
		_, err := Resolve(root, in)
		if !errors.Is(err, ErrOutsideVault) {
			t.Errorf("Resolve(%q): want ErrOutsideVault on Windows, got %v", in, err)
		}
	}
}

func TestResolve_ForwardSlashesOnWindows(t *testing.T) {
	// Protocol uses forward slashes; on Windows, Resolve must convert
	// them to backslashes when joining.
	if runtime.GOOS != "windows" {
		t.Skip("path separator behaviour is Windows-specific")
	}
	got, err := Resolve("C:\\vault", "docs/sub/a.md")
	if err != nil {
		t.Fatal(err)
	}
	want := "C:\\vault\\docs\\sub\\a.md"
	if got != want {
		t.Errorf("Resolve returned %q, want %q", got, want)
	}
}
