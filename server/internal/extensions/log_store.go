package extensions

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

const (
	maxLogBytes    int64 = 50 * 1024 * 1024
	maxLogAgeHours       = 24
)

type LogStore struct {
	dir string
	mu  sync.Mutex
}

type logLine struct {
	TS     string `json:"ts"`
	Stream string `json:"stream"`
	Data   string `json:"data"`
	Seq    int64  `json:"seq,omitempty"`
}

type doneRecord struct {
	TS       string `json:"ts"`
	Type     string `json:"type"`
	ExitCode int    `json:"exitCode"`
	Signal   string `json:"signal,omitempty"`
}

func NewLogStore(stateDir string) (*LogStore, error) {
	dir := filepath.Join(stateDir, "logs", "extensions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir log dir: %w", err)
	}
	ls := &LogStore{dir: dir}
	if err := ls.CleanupExpired(); err != nil {
		return nil, err
	}
	return ls, nil
}

func (s *LogStore) filePath(invocationID string) string {
	name := strings.ReplaceAll(invocationID, string(filepath.Separator), "_")
	return filepath.Join(s.dir, name+".jsonl")
}

func (s *LogStore) HasLog(invocationID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	fp := s.filePath(invocationID)
	st, err := os.Stat(fp)
	return err == nil && st.Size() > 0
}

func (s *LogStore) AppendBatch(invocationID string, items []proto.CliOutputBatchItem) (bool, error) {
	if len(items) == 0 {
		return true, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fp := s.filePath(invocationID)
	f, err := os.OpenFile(fp, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return false, err
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, it := range items {
		line, err := json.Marshal(logLine{
			TS:     time.Now().UTC().Format(time.RFC3339Nano),
			Stream: it.Stream,
			Data:   it.Data,
			Seq:    it.Seq,
		})
		if err != nil {
			return false, err
		}
		if _, err := w.Write(line); err != nil {
			return false, err
		}
		if err := w.WriteByte('\n'); err != nil {
			return false, err
		}
	}
	if err := w.Flush(); err != nil {
		return false, err
	}
	st, err := f.Stat()
	if err != nil {
		return false, err
	}
	if st.Size() > maxLogBytes {
		_ = os.Remove(fp)
		return false, nil
	}
	return true, nil
}

func (s *LogStore) AppendDone(invocationID string, exitCode int, signal string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fp := s.filePath(invocationID)
	f, err := os.OpenFile(fp, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	line, err := json.Marshal(doneRecord{
		TS:       time.Now().UTC().Format(time.RFC3339Nano),
		Type:     "done",
		ExitCode: exitCode,
		Signal:   signal,
	})
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	if _, err := w.Write(line); err != nil {
		return err
	}
	if err := w.WriteByte('\n'); err != nil {
		return err
	}
	return w.Flush()
}

func (s *LogStore) ReplayFrom(invocationID string, resumeFrom int64) ([]proto.CliOutputBatchItem, *proto.CliDoneParams, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	fp := s.filePath(invocationID)
	f, err := os.Open(fp)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	out := make([]proto.CliOutputBatchItem, 0, 128)
	var done *proto.CliDoneParams
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}
		if t, ok := raw["type"]; ok && string(t) == "\"done\"" {
			var rec doneRecord
			if err := json.Unmarshal(line, &rec); err == nil {
				done = &proto.CliDoneParams{
					ExitCode: rec.ExitCode,
					Signal:   rec.Signal,
				}
			}
			continue
		}
		var row logLine
		if err := json.Unmarshal(line, &row); err != nil {
			continue
		}
		if row.Seq <= resumeFrom {
			continue
		}
		out = append(out, proto.CliOutputBatchItem{
			Stream: row.Stream,
			Data:   row.Data,
			Seq:    row.Seq,
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, nil, err
	}
	return out, done, nil
}

func (s *LogStore) CleanupExpired() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-maxLogAgeHours * time.Hour)
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		fp := filepath.Join(s.dir, ent.Name())
		st, err := ent.Info()
		if err != nil {
			continue
		}
		if st.ModTime().Before(cutoff) || st.Size() > maxLogBytes {
			_ = os.Remove(fp)
		}
	}
	return nil
}
