/**
 * Method-level monkey-patch with snapshot-and-restore semantics.
 *
 * `patch(methodNames)` replaces each named method on `target` with the
 * matching method from `replacement`, after binding it to `replacement`
 * so its `this` is correct. The original value (which may be a function,
 * `undefined`, or even something exotic if the host did funny things) is
 * captured first; `restore()` puts back exactly what was there.
 *
 * If `patch` throws partway through, every swap that succeeded is rolled
 * back atomically so the target is never left in a half-patched state.
 */
export class AdapterPatcher<T extends object> {
  private originals = new Map<string, unknown>();
  private patched = false;

  constructor(
    private target: T,
    private replacement: object,
  ) {}

  isPatched(): boolean {
    return this.patched;
  }

  /**
   * Replace the named methods on `target` with bound versions from `replacement`.
   * Calling twice without `restore()` between is an error.
   */
  patch(methodNames: ReadonlyArray<keyof T & string>): void {
    if (this.patched) {
      throw new Error('AdapterPatcher: already patched (call restore first)');
    }

    const swapped: string[] = [];
    try {
      for (const name of methodNames) {
        const candidate = (this.replacement as Record<string, unknown>)[name];
        if (typeof candidate !== 'function') {
          throw new Error(`AdapterPatcher: replacement for "${name}" is not a function`);
        }
        const original = (this.target as Record<string, unknown>)[name];
        this.originals.set(name, original);
        (this.target as Record<string, unknown>)[name] = (candidate as (...args: unknown[]) => unknown).bind(this.replacement);
        swapped.push(name);
      }
      this.patched = true;
    } catch (e) {
      for (const name of swapped) {
        const original = this.originals.get(name);
        (this.target as Record<string, unknown>)[name] = original;
      }
      this.originals.clear();
      throw e;
    }
  }

  /** Put back the originals captured by `patch`. Safe to call when not patched. */
  restore(): void {
    if (!this.patched) return;
    for (const [name, original] of this.originals) {
      (this.target as Record<string, unknown>)[name] = original;
    }
    this.originals.clear();
    this.patched = false;
  }
}
