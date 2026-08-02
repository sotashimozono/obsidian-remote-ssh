package handlers

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// validateWorkingDir resolves and validates workingDir so it cannot escape vaultRoot.
// It enforces EvalSymlinks + filepath.Rel check to prevent symlink breakout.
func validateWorkingDir(vaultRoot, workingDir string) (string, *rpc.Error) {
	if strings.TrimSpace(workingDir) == "" {
		return "", rpc.ErrInvalidParams("workingDir is empty")
	}
	rootEval, err := filepath.EvalSymlinks(vaultRoot)
	if err != nil {
		return "", rpc.ErrInternal("resolve vaultRoot: " + err.Error())
	}
	var abs string
	if filepath.IsAbs(workingDir) {
		abs = filepath.Clean(workingDir)
	} else {
		abs = filepath.Join(rootEval, workingDir)
	}
	targetEval, err := filepath.EvalSymlinks(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return "", rpc.ErrFileNotFound(workingDir)
		}
		return "", rpc.ErrInvalidParams("workingDir: " + err.Error())
	}
	rel, err := filepath.Rel(rootEval, targetEval)
	if err != nil {
		return "", rpc.ErrPathOutsideVault(workingDir)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", rpc.ErrPathOutsideVault(workingDir)
	}
	st, err := os.Stat(targetEval)
	if err != nil {
		return "", rpc.ErrInvalidParams("workingDir: " + err.Error())
	}
	if !st.IsDir() {
		return "", rpc.ErrNotADirectory(workingDir)
	}
	return targetEval, nil
}
