/**
 * Member-level monkey-patch with snapshot-and-restore semantics.
 *
 * `patch(memberNames)` replaces each named member on `target` with the
 * matching member from `replacement`. Two member kinds are supported:
 *
 *   1. **Methods** (`typeof replacement[name] === 'function'`). The
 *      function is bound to `replacement` so its `this` is correct,
 *      then assigned as a data property on `target`.
 *   2. **Accessors** (`replacement` defines a getter at `name` via
 *      `Object.defineProperty` / `get` syntax). The getter is
 *      installed on `target` via `Object.defineProperty`, allowing
 *      callers that read the property (e.g. `adapter.basePath`) to
 *      receive the value computed by `replacement`.
 *
 * The original member descriptor (data property, accessor, or
 * inherited / absent) is captured first via
 * `Object.getOwnPropertyDescriptor`. `restore()` puts back exactly
 * what was there: a captured descriptor is re-installed via
 * `Object.defineProperty`; a captured `null` (member was inherited
 * or absent on the instance) restores by deleting the own property,
 * letting the prototype chain take over again.
 *
 * If `patch` throws partway through, every swap that succeeded is
 * rolled back atomically so the target is never left in a
 * half-patched state.
 */
export class AdapterPatcher<T extends object> {
  private originals = new Map<string, PropertyDescriptor | null>();
  private patched = false;

  constructor(
    private target: T,
    private replacement: object,
  ) {}

  isPatched(): boolean {
    return this.patched;
  }

  /**
   * Replace the named members on `target` with bound versions from `replacement`.
   * Calling twice without `restore()` between is an error.
   */
  patch(memberNames: ReadonlyArray<keyof T & string>): void {
    if (this.patched) {
      throw new Error('AdapterPatcher: already patched (call restore first)');
    }

    const swapped: string[] = [];
    try {
      for (const name of memberNames) {
        const originalDesc = Object.getOwnPropertyDescriptor(this.target, name) ?? null;
        this.originals.set(name, originalDesc);

        const replDesc = findMemberDescriptor(this.replacement, name);
        if (!replDesc) {
          throw new Error(`AdapterPatcher: replacement has no member "${name}"`);
        }

        if (typeof replDesc.value === 'function') {
          const fn = replDesc.value as (...args: unknown[]) => unknown;
          Object.defineProperty(this.target, name, {
            value: fn.bind(this.replacement),
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } else if (typeof replDesc.get === 'function') {
          // eslint-disable-next-line @typescript-eslint/unbound-method -- replDesc.get is invoked via .call(replObj) on the next line, never stored as an unbound callable, so the rule's concern (lost `this`) doesn't apply here.
          const replGetter = replDesc.get;
          const replObj = this.replacement;
          Object.defineProperty(this.target, name, {
            get(): unknown {
              return replGetter.call(replObj) as unknown;
            },
            configurable: true,
            enumerable: true,
          });
        } else {
          throw new Error(
            `AdapterPatcher: replacement for "${name}" is neither a function nor a getter`,
          );
        }
        swapped.push(name);
      }
      this.patched = true;
    } catch (e) {
      for (const name of swapped) {
        this.restoreOne(name);
      }
      this.originals.clear();
      throw e;
    }
  }

  /** Put back the originals captured by `patch`. Safe to call when not patched. */
  restore(): void {
    if (!this.patched) return;
    for (const name of this.originals.keys()) {
      this.restoreOne(name);
    }
    this.originals.clear();
    this.patched = false;
  }

  private restoreOne(name: string): void {
    const original = this.originals.get(name);
    if (original === undefined) return;
    if (original === null) {
      delete (this.target as Record<string, unknown>)[name];
    } else {
      Object.defineProperty(this.target, name, original);
    }
  }
}

/**
 * Look up a member descriptor on `host`, walking up the prototype
 * chain. Class methods defined with `method() {}` and accessors
 * defined with `get name() {}` live on the prototype, not the
 * instance, so a plain `Object.getOwnPropertyDescriptor(host, name)`
 * misses them.
 */
function findMemberDescriptor(host: object, name: string): PropertyDescriptor | undefined {
  let cur: object | null = host;
  while (cur) {
    const desc = Object.getOwnPropertyDescriptor(cur, name);
    if (desc) return desc;
    cur = Object.getPrototypeOf(cur) as object | null;
  }
  return undefined;
}
