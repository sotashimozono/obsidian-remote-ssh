import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { ShadowStartupCoordinator } from '../src/shadow/ShadowStartupCoordinator';
import type { PluginSettings, PendingPluginSuggestion } from '../src/types';

// ─── Module mocks ──────────────────────────────────────────────────────────
//
// vi.hoisted() runs before vi.mock() hoisting so the spy references are
// stable by the time the mock factories execute.

const { mockPrompt, mockInstallMissing } = vi.hoisted(() => ({
  mockPrompt: vi.fn(),
  mockInstallMissing: vi.fn().mockResolvedValue({ installed: [], skipped: [], failed: [] }),
}));

vi.mock('../src/ui/PendingPluginsModal', () => ({
  PendingPluginsModal: class {
    prompt() { return mockPrompt(); }
  },
}));

vi.mock('../src/shadow/PluginMarketplaceInstaller', () => ({
  PluginMarketplaceInstaller: class {
    installMissing(ids: string[]) { return mockInstallMissing(ids); }
  },
}));

// ─── Helpers ───────────────────────────────────────────────────────────────

const SUGGESTION: PendingPluginSuggestion = {
  id: 'dataview',
  name: 'Dataview',
  sourceData: { index: true },
};

function make(partialSettings: Partial<PluginSettings> = {}) {
  const saveSettings = vi.fn(async () => {});
  const app = new App();
  const settings = { ...partialSettings } as PluginSettings;
  return {
    coord: new ShadowStartupCoordinator(app, settings, saveSettings),
    saveSettings,
    settings,
  };
}

beforeEach(() => {
  mockPrompt.mockReset();
  mockInstallMissing.mockReset();
  mockInstallMissing.mockResolvedValue({ installed: [], skipped: [], failed: [] });
});

// ─── No-op paths (suggestions absent) ─────────────────────────────────────

describe('ShadowStartupCoordinator — no suggestions', () => {
  it('resolves without throwing when pendingPluginSuggestions is undefined', async () => {
    const { coord } = make({ pendingPluginSuggestions: undefined });
    await expect(coord.prepareForAutoConnect()).resolves.toBeUndefined();
  });

  it('resolves without throwing when pendingPluginSuggestions is an empty array', async () => {
    const { coord } = make({ pendingPluginSuggestions: [] });
    await expect(coord.prepareForAutoConnect()).resolves.toBeUndefined();
  });

  it('never opens the modal when there are no suggestions', async () => {
    const { coord } = make({ pendingPluginSuggestions: undefined });
    await coord.prepareForAutoConnect();
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it('does not call saveSettings when suggestions are absent', async () => {
    const { coord, saveSettings } = make({ pendingPluginSuggestions: undefined });
    await coord.prepareForAutoConnect();
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

// ─── Decision: 'later' ─────────────────────────────────────────────────────
//
// Architecture §9/F2: "Ask later" leaves pendingPluginSuggestions in place
// so the modal re-prompts on the next shadow-window reload.

describe('ShadowStartupCoordinator — decision: later', () => {
  it('does not clear pendingPluginSuggestions when the user picks "later"', async () => {
    mockPrompt.mockResolvedValue({ decision: 'later' });
    const { coord, settings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(settings.pendingPluginSuggestions).toEqual([SUGGESTION]);
  });

  it('does not call saveSettings when the user picks "later"', async () => {
    mockPrompt.mockResolvedValue({ decision: 'later' });
    const { coord, saveSettings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('does not install anything when the user picks "later"', async () => {
    mockPrompt.mockResolvedValue({ decision: 'later' });
    const { coord } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(mockInstallMissing).not.toHaveBeenCalled();
  });
});

// ─── Decision: 'skip' ──────────────────────────────────────────────────────
//
// User opts out permanently for this bootstrap snapshot. The coordinator
// must clear pendingPluginSuggestions and persist the change.

describe('ShadowStartupCoordinator — decision: skip', () => {
  it('clears pendingPluginSuggestions when the user picks "skip"', async () => {
    mockPrompt.mockResolvedValue({ decision: 'skip' });
    const { coord, settings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(settings.pendingPluginSuggestions).toBeUndefined();
  });

  it('calls saveSettings exactly once when the user picks "skip"', async () => {
    mockPrompt.mockResolvedValue({ decision: 'skip' });
    const { coord, saveSettings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('does not install anything when the user picks "skip"', async () => {
    mockPrompt.mockResolvedValue({ decision: 'skip' });
    const { coord } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(mockInstallMissing).not.toHaveBeenCalled();
  });
});

// ─── Decision: 'install' ───────────────────────────────────────────────────
//
// Core F2 flow: user selects plugins → installMissing is called →
// snapshot cleared → settings persisted. The shadow vault architecture
// (§9) specifies that this runs before auto-connect so plugins are on
// disk when the SSH session opens.

describe('ShadowStartupCoordinator — decision: install', () => {
  it('calls installMissing with the selected plugin ids', async () => {
    mockPrompt.mockResolvedValue({ decision: 'install', selected: ['dataview'], copyConfig: false });
    mockInstallMissing.mockResolvedValue({ installed: ['dataview'], skipped: [], failed: [] });
    const { coord } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(mockInstallMissing).toHaveBeenCalledWith(['dataview']);
  });

  it('clears pendingPluginSuggestions after install', async () => {
    mockPrompt.mockResolvedValue({ decision: 'install', selected: ['dataview'], copyConfig: false });
    mockInstallMissing.mockResolvedValue({ installed: ['dataview'], skipped: [], failed: [] });
    const { coord, settings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(settings.pendingPluginSuggestions).toBeUndefined();
  });

  it('calls saveSettings after install', async () => {
    mockPrompt.mockResolvedValue({ decision: 'install', selected: ['dataview'], copyConfig: false });
    mockInstallMissing.mockResolvedValue({ installed: ['dataview'], skipped: [], failed: [] });
    const { coord, saveSettings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('clears snapshot and saves when user unticks all (empty selected list)', async () => {
    mockPrompt.mockResolvedValue({ decision: 'install', selected: [], copyConfig: false });
    const { coord, settings, saveSettings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(settings.pendingPluginSuggestions).toBeUndefined();
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(mockInstallMissing).not.toHaveBeenCalled();
  });

  it('still clears snapshot and saves when all installs fail', async () => {
    mockPrompt.mockResolvedValue({ decision: 'install', selected: ['dataview'], copyConfig: false });
    mockInstallMissing.mockResolvedValue({
      installed: [],
      skipped: [],
      failed: [{ id: 'dataview', error: 'network error' }],
    });
    const { coord, settings, saveSettings } = make({ pendingPluginSuggestions: [SUGGESTION] });
    await coord.prepareForAutoConnect();
    expect(settings.pendingPluginSuggestions).toBeUndefined();
    expect(saveSettings).toHaveBeenCalledOnce();
  });
});
