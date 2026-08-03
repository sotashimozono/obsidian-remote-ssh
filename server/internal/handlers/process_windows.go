//go:build windows

package handlers

import (
	"errors"
	"os"
	"os/exec"
)

// setProcessGroup is a no-op on Windows: there are no POSIX process
// groups to put cmd in. killProcessGroup falls back to killing the
// direct child only.
func setProcessGroup(cmd *exec.Cmd) {}

// killProcessGroup kills cmd directly. Grandchildren that survive may
// keep the pipe write end open, so a reap on Windows can still leak an
// invocation slot; the daemon targets unix hosts, where the group kill
// covers the whole tree.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	err := cmd.Process.Kill()
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}
