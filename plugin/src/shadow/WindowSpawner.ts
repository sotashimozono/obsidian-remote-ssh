import { logger } from '../util/logger';

/**
 * Pluggable URL launcher. Default implementation calls
 * `window.open(url)` on the renderer; tests pass a recording stub.
 */
export interface UrlOpener {
  openUrl(url: string): void;
}

/**
 * Triggers Obsidian's main process to open a vault path in a new
 * window via the documented `obsidian://open?path=…` URL scheme.
 *
 * The vault path must already be registered in `obsidian.json`
 * (see `ObsidianRegistry.register`) — for an unregistered path
 * Obsidian's URL handler falls back to its vault picker UI instead
 * of opening the path directly.
 */
export class WindowSpawner {
  constructor(private readonly opener: UrlOpener = defaultUrlOpener()) {}

  spawn(vaultPath: string): string {
    const url = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
    logger.info(`WindowSpawner: firing ${url}`);
    this.opener.openUrl(url);
    return url;
  }
}

function defaultUrlOpener(): UrlOpener {
  return {
    openUrl(url: string) {
      // `_blank` so the browser-style window manager treats it as a
      // new top-level window — Obsidian's main process intercepts
      // the obsidian:// scheme regardless of target.
      window.open(url, '_blank');
    },
  };
}
