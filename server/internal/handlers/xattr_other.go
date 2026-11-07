//go:build !linux && !darwin

package handlers

import (
	"errors"
	"os"
)

func inodeOf(os.FileInfo) (uint64, bool) { return 0, false }

func deviceOf(os.FileInfo) (uint64, bool) { return 0, false }

func isLocalFS(string) bool { return false }

func xattrAbsent(err error) bool { return errors.Is(err, errors.ErrUnsupported) }

var getXattr = func(string, string, []byte) (int, error) { return 0, errors.ErrUnsupported }

var setXattr = func(string, string, []byte) error { return errors.ErrUnsupported }
