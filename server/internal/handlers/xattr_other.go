//go:build !linux && !darwin

package handlers

import (
	"errors"
	"os"
)

func inodeOf(os.FileInfo) (uint64, bool) { return 0, false }

var getXattr = func(string, string, []byte) (int, error) { return 0, errors.ErrUnsupported }

var setXattr = func(string, string, []byte) error { return errors.ErrUnsupported }

func removeXattr(string, string) error { return errors.ErrUnsupported }
