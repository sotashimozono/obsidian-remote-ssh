/**
 * Adapter reads, held while closed. Not writes: decided against the stale
 * pre-connect model and replayed onto the remote later, they could overwrite
 * notes created elsewhere since, with no conflict check.
 */
const GATED_METHODS = ['read', 'readBinary', 'exists', 'stat', 'list'] as const;

type Fn = (...args: unknown[]) => unknown;

/**
 * Holds a shadow vault's note reads from layout-ready until the remote adapter
 * is patched in.
 *
 * Until then the only adapter is Obsidian's native one, pointed at a shadow
 * folder holding no notes, so a read fails with ENOENT. Plugins that index at
 * layout-ready don't all recover from that —
 * Dataview's import worker stays busy for the rest of the session after one
 * failed read, so no new or edited note is ever indexed.
 *
 * Installed in onload, so it is in place whatever order plugins load in, but
 * holding only from layout-ready: Obsidian may await a note read on the way
 * there, and the connect starts there. Config-dir paths always pass: plugin
 * settings live on the shadow disk. No timeout: whoever installs it must open
 * it, and nothing that runs before the connect may wait on it.
 */
export class StartupReadGate {
  private readonly native = new Map<string, Fn>();
  private readonly wrappers = new Map<string, Fn>();
  /** Own descriptors replaced by `install`; null where the member was inherited. */
  private readonly replaced = new Map<string, PropertyDescriptor | null>();
  /** Members another plugin wrapped over the gate: the wrapper on top at uninstall. */
  private readonly buriedUnder = new Map<string, unknown>();
  private opened = false;
  private release!: () => void;
  private readonly released = new Promise<void>((r) => { this.release = r; });

  constructor(
    private readonly adapter: Record<string, unknown>,
    private readonly opts: { configDir: string; layoutReady: () => boolean },
  ) {}

  install(): void {
    for (const name of GATED_METHODS) {
      if (typeof this.adapter[name] !== 'function') continue;
      this.native.set(name, (this.adapter[name] as Fn).bind(this.adapter));
      this.replaced.set(name, Object.getOwnPropertyDescriptor(this.adapter, name) ?? null);
      const wrapper: Fn = (...args) => this.call(name, args);
      this.wrappers.set(name, wrapper);
      this.adapter[name] = wrapper;
    }
  }

  /**
   * Take the wrappers off, so a patcher installed next captures what was there
   * before. A member another plugin has since wrapped is left alone: the gate
   * underneath it passes straight through once open.
   */
  uninstall(): void {
    for (const [name, wrapper] of this.wrappers) {
      if (this.adapter[name] !== wrapper) {
        this.buriedUnder.set(name, this.adapter[name]);
        continue;
      }
      const before = this.replaced.get(name);
      if (before) Object.defineProperty(this.adapter, name, before);
      else delete this.adapter[name];
    }
    this.wrappers.clear();
  }

  /**
   * Release every held call: each re-dispatches through the adapter's member
   * as it is now — the remote one if it was patched in, else native.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.uninstall();
    this.release();
  }

  private call(name: string, args: unknown[]): unknown {
    const path = args[0];
    if (this.opened || !this.opts.layoutReady() || typeof path !== 'string' || this.isConfigPath(path)) {
      return this.native.get(name)!(...args);
    }
    return this.released.then(() => this.dispatch(name, args));
  }

  /**
   * A held call already went through any wrapper above the gate on its way
   * in, so it re-enters below it: the adapter's member as it is now — unless
   * that is still the wrapper that sat on top of the gate, which would run a
   * second time. Then the member the gate replaced.
   */
  private dispatch(name: string, args: unknown[]): unknown {
    const top = this.adapter[name];
    if (this.buriedUnder.has(name) && top === this.buriedUnder.get(name)) {
      return this.native.get(name)!(...args);
    }
    return (top as Fn).apply(this.adapter, args);
  }

  private isConfigPath(path: string): boolean {
    const dir = this.opts.configDir;
    return path === dir || path.startsWith(dir + '/');
  }
}
