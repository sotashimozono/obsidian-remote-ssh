//go:build !linux && !darwin

package handlers

import "os"

func birthMillis(string, os.FileInfo) (int64, bool) { return 0, false }
