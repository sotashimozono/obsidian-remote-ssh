//go:build !linux && !darwin

package handlers

import (
	"errors"
	"os"
)

func inodeOf(os.FileInfo) (uint64, bool) { return 0, false }

func getXattr(string, string, []byte) (int, error) { return 0, errors.ErrUnsupported }

func setXattr(string, string, []byte) error { return errors.ErrUnsupported }

func removeXattr(string, string) error { return errors.ErrUnsupported }
