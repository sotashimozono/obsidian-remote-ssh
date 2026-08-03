//go:build unix

package handlers

import (
	"errors"
	"os/exec"
	"syscall"
)

// setProcessGroup makes cmd the leader of a new process group so that
// killProcessGroup can signal the whole tree, not just the direct
// child. Without this, a grandchild spawned by the tool keeps the pipe
// write end open after the direct child dies, EOF never arrives, and
// streamProcess never releases its invocation slot.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup kills cmd and every process in its group. A nil
// Process (never started) and an already-exited group are no-ops.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	// Negative pid targets the whole process group (see setProcessGroup).
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return cmd.Process.Kill()
	}
	return nil
}
