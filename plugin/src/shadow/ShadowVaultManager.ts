import type { SshProfile } from '../types';
import type { ShadowVaultBootstrap, BootstrapResult } from './ShadowVaultBootstrap';
import type { WindowSpawner } from './WindowSpawner';

/**
 * Top-level orchestrator for the shadow-vault flow:
 *   1. ShadowVaultBootstrap materialises the on-disk vault for the
 *      profile (creates dir, installs plugin, writes data.json with
 *      auto-connect marker, registers the path in obsidian.json).
 *   2. WindowSpawner fires the `obsidian://open?path=…` URL so
 *      Obsidian opens the new vault in its own window.
 *
 * The shadow window's plugin onload then sees the auto-connect
 * marker and runs the actual remote connect — that wiring lands in
 * Phase 4. For Phase 2 the manager just gets a fresh window pointed
 * at the right empty vault.
 */
export class ShadowVaultManager {
  constructor(
    private readonly bootstrap: ShadowVaultBootstrap,
    private readonly spawner: WindowSpawner,
  ) {}

  async openShadowFor(
    profile: SshProfile,
    allProfiles: ReadonlyArray<SshProfile>,
  ): Promise<BootstrapResult> {
    const result = await this.bootstrap.bootstrap(profile, allProfiles);
    this.spawner.spawn(result.layout.vaultDir);
    return result;
  }
}
