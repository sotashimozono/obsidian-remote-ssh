package extensions

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// Manifest is the on-disk capabilities document.
type Manifest struct {
	Version    int                         `json:"version"`
	Extensions []proto.ExtensionCapability `json:"extensions"`
}

// Manager owns loaded extension capabilities and the manifest digest.
type Manager struct {
	manifestPath string
	manifestHash string
	manifest     Manifest
	byTool       map[string]proto.ExtensionCapability
}

// LoadAndVerify reads capabilities.json and verifies executable digests.
func LoadAndVerify(path string) (*Manager, error) {
	m := &Manager{manifestPath: path, byTool: map[string]proto.ExtensionCapability{}}
	if strings.TrimSpace(path) == "" {
		m.manifest = Manifest{Version: 1, Extensions: []proto.ExtensionCapability{}}
		return m, nil
	}

	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			m.manifest = Manifest{Version: 1, Extensions: []proto.ExtensionCapability{}}
			return m, nil
		}
		return nil, fmt.Errorf("read capabilities: %w", err)
	}
	sum := sha256.Sum256(body)
	m.manifestHash = hex.EncodeToString(sum[:])

	var doc Manifest
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("parse capabilities: %w", err)
	}
	if doc.Version < 1 {
		return nil, fmt.Errorf("invalid capabilities version: %d", doc.Version)
	}
	for _, ext := range doc.Extensions {
		if err := validateCapability(ext); err != nil {
			return nil, err
		}
		if err := verifyBinarySHA256(ext.Command, ext.SHA256); err != nil {
			return nil, fmt.Errorf("tool %q: %w", ext.Tool, err)
		}
		m.byTool[ext.Tool] = ext
	}
	m.manifest = doc
	return m, nil
}

func validateCapability(ext proto.ExtensionCapability) error {
	if strings.TrimSpace(ext.Tool) == "" {
		return fmt.Errorf("capability tool is required")
	}
	if strings.TrimSpace(ext.Command) == "" {
		return fmt.Errorf("capability %q command is required", ext.Tool)
	}
	if !filepath.IsAbs(ext.Command) {
		return fmt.Errorf("capability %q command must be absolute: %s", ext.Tool, ext.Command)
	}
	if matched, _ := regexp.MatchString("^[a-fA-F0-9]{64}$", ext.SHA256); !matched {
		return fmt.Errorf("capability %q sha256 must be 64 hex chars", ext.Tool)
	}
	for _, r := range ext.Args {
		if strings.TrimSpace(r.Name) == "" {
			return fmt.Errorf("capability %q has arg rule with empty name", ext.Tool)
		}
		if strings.TrimSpace(r.Pattern) != "" {
			if _, err := regexp.Compile(r.Pattern); err != nil {
				return fmt.Errorf("capability %q arg %q invalid pattern: %w", ext.Tool, r.Name, err)
			}
		}
	}
	return nil
}

func verifyBinarySHA256(commandPath, expectedHex string) error {
	resolved := commandPath
	if r, err := filepath.EvalSymlinks(commandPath); err == nil {
		resolved = r
	}
	body, err := os.ReadFile(resolved)
	if err != nil {
		return fmt.Errorf("read executable: %w", err)
	}
	sum := sha256.Sum256(body)
	actual := strings.ToLower(hex.EncodeToString(sum[:]))
	if actual != strings.ToLower(expectedHex) {
		return fmt.Errorf("sha256 mismatch")
	}
	return nil
}

// SchemaResult returns the current extension schema document.
func (m *Manager) SchemaResult() proto.ExtensionSchemaResult {
	return proto.ExtensionSchemaResult{
		Version:        m.manifest.Version,
		ManifestSHA256: m.manifestHash,
		Extensions:     append([]proto.ExtensionCapability(nil), m.manifest.Extensions...),
	}
}

// ResolveTool returns the capability for one tool.
func (m *Manager) ResolveTool(tool string) (proto.ExtensionCapability, bool) {
	ext, ok := m.byTool[tool]
	return ext, ok
}

// VerifyToolBinary re-checks the executable digest for a configured tool.
func (m *Manager) VerifyToolBinary(tool string) error {
	ext, ok := m.byTool[tool]
	if !ok {
		return fmt.Errorf("tool not found")
	}
	if err := verifyBinarySHA256(ext.Command, ext.SHA256); err != nil {
		return err
	}
	return nil
}
