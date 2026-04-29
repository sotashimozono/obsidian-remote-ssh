import * as path from 'path';
import type { PluginManifest } from 'obsidian';
import { logger } from './logger';
import { installErrorHook, uninstallErrorHook } from './errorHook';

/**
 * Owns the install / uninstall sequence for the plugin's observability
 * stack: per-vault file-sink for the JSONL logger, console wrap so
 * console.error / console.warn flow into the same sink, and the
 * window-level errorHook that captures unhandled exceptions.
 *
 * Extracted from main.ts (Phase Refactor / God-file split). The two
 * methods used to be private on RemoteSshPlugin and were always called
 * as a pair from onload / onunload — this just gives them a name and a
 * single owner.
 */
export class ObservabilityInstaller {
  /**
   * @param manifest        plugin's own manifest (used for the log line + sink path)
   * @param vaultBasePath   absolute path to the vault root, or null if
   *                        the vault is not FileSystemAdapter-backed
   *                        (mobile / unusual setups). When null the
   *                        file sink is skipped and a warning is logged.
   */
  constructor(
    private readonly manifest: PluginManifest,
    private readonly vaultBasePath: string | null,
  ) {}

  install(): void {
    try {
      if (this.vaultBasePath) {
        const logPath = path.join(
          this.vaultBasePath, '.obsidian', 'plugins', this.manifest.id, 'console.log',
        );
        logger.installFileSink(logPath);
      } else {
        logger.warn('vault.adapter is not FileSystemAdapter; file sink disabled');
      }
    } catch (e) {
      logger.warn(`installFileSink failed: ${(e as Error).message}`);
    }
    logger.wrapConsole();
    installErrorHook();
    logger.info(`Plugin ${this.manifest.id} v${this.manifest.version} loaded`);
  }

  uninstall(): void {
    logger.info(`Plugin ${this.manifest.id} unloading`);
    uninstallErrorHook();
    logger.unwrapConsole();
    logger.uninstallFileSink();
  }
}
