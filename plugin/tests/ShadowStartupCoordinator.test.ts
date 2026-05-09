import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { ShadowStartupCoordinator } from '../src/shadow/ShadowStartupCoordinator';
import type { PluginSettings } from '../src/types';

/**
 * Build a coordinator with a mocked App (from the obsidian stub) and a
 * minimal settings slice. The obsidian-mock's FileSystemAdapter returns
 * '/synthetic/vault' as basePath; community-plugins.json will not exist
 * there, so installMissingShadowPlugins exits after the existsSync check.
 */
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

// ─── prepareForAutoConnect ────────────────────────────────────────────────

describe('ShadowStartupCoordinator.prepareForAutoConnect()', () => {
  it('resolves without throwing when pendingPluginSuggestions is undefined', async () => {
    const { coord } = make({ pendingPluginSuggestions: undefined });
    await expect(coord.prepareForAutoConnect()).resolves.toBeUndefined();
  });

  it('resolves without throwing when pendingPluginSuggestions is an empty array', async () => {
    const { coord } = make({ pendingPluginSuggestions: [] });
    await expect(coord.prepareForAutoConnect()).resolves.toBeUndefined();
  });

  it('does not call saveSettings when suggestions are absent', async () => {
    const { coord, saveSettings } = make({ pendingPluginSuggestions: undefined });
    await coord.prepareForAutoConnect();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('does not call saveSettings when suggestion list is empty', async () => {
    const { coord, saveSettings } = make({ pendingPluginSuggestions: [] });
    await coord.prepareForAutoConnect();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('can be called multiple times without throwing', async () => {
    const { coord } = make({ pendingPluginSuggestions: undefined });
    await coord.prepareForAutoConnect();
    await expect(coord.prepareForAutoConnect()).resolves.toBeUndefined();
  });
});
