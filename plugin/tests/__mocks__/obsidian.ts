/**
 * Runtime mock for the `obsidian` module.
 *
 * The published `obsidian` npm package is *types only* — there's no
 * implementation of `Modal`, `Setting`, `Notice`, etc. UI tests that
 * `import { Modal } from 'obsidian'` need a runtime to instantiate.
 * Vitest resolves `import 'obsidian'` here via the `resolve.alias`
 * entry in `vitest.config.ts`.
 *
 * Surface: only the slice the plugin's UI / settings code actually
 * touches (Modal, Setting, Notice, PluginSettingTab, FileSystemAdapter
 * stub, plus the `el.createEl / createDiv / createSpan / addClass /
 * removeClass / setText` Obsidian DOM extensions). Add more as new
 * UI files start importing them.
 *
 * Tests that need to assert on Notices or the rendered DOM use:
 *   - `recordedNotices()` — every Notice that's been constructed
 *   - `clearNotices()` — drop the buffer between tests
 */

// ─── Notice ──────────────────────────────────────────────────────────

const noticeBuffer: string[] = [];

export class Notice {
  constructor(public readonly message: string, public readonly timeoutMs?: number) {
    noticeBuffer.push(message);
  }
}

export function recordedNotices(): readonly string[] {
  return [...noticeBuffer];
}

export function clearNotices(): void {
  noticeBuffer.length = 0;
}

// ─── DOM extensions ──────────────────────────────────────────────────
//
// Obsidian extends HTMLElement with a few helpers. Patch the prototype
// once at module load so source code that calls `el.createEl(...)`
// works against jsdom or Node's WHATWG-DOM-less env. We use the global
// `document` if available (jsdom); otherwise we synthesise a minimal
// element tree that supports the methods Obsidian-extended elements
// have.

interface DomOptions {
  text?: string;
  cls?: string | string[];
  type?: string;
  attr?: Record<string, string | number | boolean>;
  placeholder?: string;
  href?: string;
}

function applyDomOptions(el: HTMLElement, opts?: DomOptions): void {
  if (!opts) return;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.cls) {
    const cls = Array.isArray(opts.cls) ? opts.cls : [opts.cls];
    for (const c of cls) el.classList.add(c);
  }
  if (opts.type !== undefined) (el as HTMLInputElement).type = opts.type;
  if (opts.placeholder !== undefined) (el as HTMLInputElement).placeholder = opts.placeholder;
  if (opts.href !== undefined) (el as HTMLAnchorElement).href = opts.href;
  if (opts.attr) {
    for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
  }
}

const PATCH_FLAG = Symbol.for('obsidian-mock.patched');

function patchDom(): void {
  if (typeof HTMLElement === 'undefined') return;
  const proto = HTMLElement.prototype as unknown as Record<string | symbol, unknown>;
  if (proto[PATCH_FLAG]) return;

  // Match the real Obsidian signatures exactly. The real createEl
  // accepts an optional `callback?: (el) => void` third argument that
  // many Obsidian patterns use for chained subtree setup; if we drop
  // it the callback subtree silently never runs and tests pass green.
  proto.createEl = function <K extends keyof HTMLElementTagNameMap>(
    this: HTMLElement, tag: K, opts?: DomOptions,
    callback?: (el: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    applyDomOptions(el as HTMLElement, opts);
    this.appendChild(el);
    if (callback) callback(el);
    return el;
  };
  proto.createDiv = function (
    this: HTMLElement,
    opts?: DomOptions | string,
    callback?: (el: HTMLDivElement) => void,
  ): HTMLDivElement {
    const o: DomOptions | undefined = typeof opts === 'string' ? { cls: opts } : opts;
    const el = (this as unknown as {
      createEl: <K extends 'div'>(t: K, o?: DomOptions, cb?: (el: HTMLDivElement) => void) => HTMLDivElement
    }).createEl('div', o, callback);
    return el;
  };
  proto.createSpan = function (
    this: HTMLElement,
    opts?: DomOptions | string,
    callback?: (el: HTMLSpanElement) => void,
  ): HTMLSpanElement {
    const o: DomOptions | undefined = typeof opts === 'string' ? { cls: opts } : opts;
    const el = (this as unknown as {
      createEl: <K extends 'span'>(t: K, o?: DomOptions, cb?: (el: HTMLSpanElement) => void) => HTMLSpanElement
    }).createEl('span', o, callback);
    return el;
  };
  proto.empty = function (this: HTMLElement): void {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  // Real Obsidian: addClass(...classes: string[]). Single-string callers
  // still work because rest-spread on one arg is the same shape.
  proto.addClass = function (this: HTMLElement, ...classes: string[]): void {
    for (const c of classes) this.classList.add(c);
  };
  proto.removeClass = function (this: HTMLElement, ...classes: string[]): void {
    for (const c of classes) this.classList.remove(c);
  };
  // Real Obsidian: setText(string | DocumentFragment). A fragment must
  // be appended after clearing — coercing it to a string yields garbage.
  proto.setText = function (this: HTMLElement, t: string | DocumentFragment): void {
    if (typeof t === 'string') {
      this.textContent = t;
    } else {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.appendChild(t);
    }
  };
  proto.appendText = function (this: HTMLElement, t: string): void {
    this.appendChild(document.createTextNode(t));
  };
  // Real Obsidian: toggleClass(classes: string | string[], value: boolean).
  proto.toggleClass = function (this: HTMLElement, c: string | string[], on: boolean): void {
    const list = Array.isArray(c) ? c : [c];
    for (const item of list) this.classList.toggle(item, on);
  };

  proto[PATCH_FLAG] = true;
}

patchDom();

// ─── Setting ─────────────────────────────────────────────────────────
//
// Chainable. Each `add*` returns the Setting itself (matching the real
// API). The component callbacks (text/toggle/etc.) receive a small
// shim with the same chainable surface the production callers expect.

export interface TextComponent {
  readonly kind: 'text';
  setValue(v: string): TextComponent;
  setPlaceholder(p: string): TextComponent;
  onChange(cb: (v: string) => void | Promise<void>): TextComponent;
  /** Test helper: simulate user typing. Throws if no `onChange` was registered. */
  simulateInput(v: string): Promise<void>;
}

export interface ToggleComponent {
  readonly kind: 'toggle';
  setValue(v: boolean): ToggleComponent;
  onChange(cb: (v: boolean) => void | Promise<void>): ToggleComponent;
  /** Test helper: simulate flipping the toggle. Throws if no `onChange` was registered. */
  simulateChange(v: boolean): Promise<void>;
}

export interface ButtonComponent {
  readonly kind: 'button';
  setButtonText(t: string): ButtonComponent;
  setCta(): ButtonComponent;
  setWarning(): ButtonComponent;
  setDisabled(b: boolean): ButtonComponent;
  setText(t: string): ButtonComponent;
  onClick(cb: () => void | Promise<void>): ButtonComponent;
  buttonEl: HTMLButtonElement;
  /** Test helper: simulate the click. Throws if no `onClick` was registered. */
  simulateClick(): Promise<void>;
}

export interface DropdownComponent {
  readonly kind: 'dropdown';
  addOption(value: string, label: string): DropdownComponent;
  setValue(v: string): DropdownComponent;
  onChange(cb: (v: string) => void | Promise<void>): DropdownComponent;
  /** Test helper: simulate selection change. Throws if no `onChange` was registered. */
  simulateChange(v: string): Promise<void>;
}

export type AnyComponent = TextComponent | ToggleComponent | ButtonComponent | DropdownComponent;

// `simulate*` throws when no callback was registered. A green test is
// only meaningful if it actually fired the SUT's wiring; a silent
// no-op turns "test passes" into "we never asserted anything."
function makeText(): TextComponent {
  let onChange: ((v: string) => void | Promise<void>) | null = null;
  const c: TextComponent = {
    kind: 'text',
    setValue() { return c; },
    setPlaceholder() { return c; },
    onChange(cb) { onChange = cb; return c; },
    async simulateInput(v) {
      if (!onChange) throw new Error('simulateInput called but no onChange was registered on this TextComponent');
      await onChange(v);
    },
  };
  return c;
}

function makeToggle(): ToggleComponent {
  let onChange: ((v: boolean) => void | Promise<void>) | null = null;
  const c: ToggleComponent = {
    kind: 'toggle',
    setValue() { return c; },
    onChange(cb) { onChange = cb; return c; },
    async simulateChange(v) {
      if (!onChange) throw new Error('simulateChange called but no onChange was registered on this ToggleComponent');
      await onChange(v);
    },
  };
  return c;
}

function makeButton(): ButtonComponent {
  let onClick: (() => void | Promise<void>) | null = null;
  const buttonEl = document.createElement('button');
  // Wire the native click event so `containerEl.querySelector('button').click()`
  // also fires the registered handler. Without this, query-and-click test
  // patterns silently no-op against the mock.
  buttonEl.addEventListener('click', () => {
    if (onClick) void onClick();
  });
  const c: ButtonComponent = {
    kind: 'button',
    setButtonText(t) { (buttonEl as HTMLButtonElement).textContent = t; return c; },
    setCta() { return c; },
    setWarning() { return c; },
    setDisabled(b) { (buttonEl as HTMLButtonElement).disabled = b; return c; },
    setText(t) { (buttonEl as HTMLButtonElement).textContent = t; return c; },
    onClick(cb) { onClick = cb; return c; },
    buttonEl,
    async simulateClick() {
      if (!onClick) throw new Error('simulateClick called but no onClick was registered on this ButtonComponent');
      await onClick();
    },
  };
  return c;
}

function makeDropdown(): DropdownComponent {
  let onChange: ((v: string) => void | Promise<void>) | null = null;
  const c: DropdownComponent = {
    kind: 'dropdown',
    addOption() { return c; },
    setValue() { return c; },
    onChange(cb) { onChange = cb; return c; },
    async simulateChange(v) {
      if (!onChange) throw new Error('simulateChange called but no onChange was registered on this DropdownComponent');
      await onChange(v);
    },
  };
  return c;
}

// Registry keyed by `Setting.settingEl` so test helpers can look the
// owning Setting up given a DOM node — avoids fragile prototype
// patching from the test side.
const settingByEl = new WeakMap<HTMLElement, Setting>();

/** Look up the `Setting` instance owning a `.setting-item` element. */
export function getSettingFor(el: HTMLElement): Setting | undefined {
  return settingByEl.get(el);
}

/** Walk all `Setting`s rendered into `root`, in DOM order. */
export function getSettingsIn(root: HTMLElement): Setting[] {
  const out: Setting[] = [];
  for (const el of Array.from(root.querySelectorAll('.setting-item'))) {
    const s = settingByEl.get(el as HTMLElement);
    if (s) out.push(s);
  }
  return out;
}

export class Setting {
  /** Last-attached components, in attach order. Test helper. */
  readonly components: AnyComponent[] = [];
  /** The row this Setting renders into (a child of containerEl). */
  readonly settingEl: HTMLElement;
  private nameEl: HTMLElement;
  private descEl: HTMLElement;
  private controlEl: HTMLElement;
  private isHeading = false;

  constructor(public readonly containerEl: HTMLElement) {
    // Mirror the real Obsidian DOM tree shape just enough for tests
    // that walk `.textContent` to see Setting names + descriptions.
    this.settingEl = document.createElement('div');
    this.settingEl.className = 'setting-item';
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'setting-item-name';
    this.descEl = document.createElement('div');
    this.descEl.className = 'setting-item-description';
    this.controlEl = document.createElement('div');
    this.controlEl.className = 'setting-item-control';
    this.settingEl.appendChild(this.nameEl);
    this.settingEl.appendChild(this.descEl);
    this.settingEl.appendChild(this.controlEl);
    containerEl.appendChild(this.settingEl);
    settingByEl.set(this.settingEl, this);
  }

  setName(n: string): this { this.nameEl.textContent = n; return this; }
  setDesc(d: string): this { this.descEl.textContent = d; return this; }
  setHeading(): this {
    this.isHeading = true;
    this.settingEl.classList.add('setting-item-heading');
    return this;
  }

  addText(cb: (t: TextComponent) => void): this {
    const t = makeText();
    cb(t);
    this.components.push(t);
    return this;
  }
  addToggle(cb: (t: ToggleComponent) => void): this {
    const t = makeToggle();
    cb(t);
    this.components.push(t);
    return this;
  }
  addButton(cb: (b: ButtonComponent) => void): this {
    const b = makeButton();
    cb(b);
    this.controlEl.appendChild(b.buttonEl);
    this.components.push(b);
    return this;
  }
  addDropdown(cb: (d: DropdownComponent) => void): this {
    const d = makeDropdown();
    cb(d);
    this.components.push(d);
    return this;
  }

  /** Test introspection. */
  getName(): string { return this.nameEl.textContent ?? ''; }
  getDesc(): string { return this.descEl.textContent ?? ''; }
  isHeadingSetting(): boolean { return this.isHeading; }
}

// ─── Modal / PluginSettingTab ────────────────────────────────────────

export class Modal {
  contentEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;

  constructor(public readonly app: App) {
    this.modalEl = document.createElement('div');
    this.titleEl = document.createElement('h2');
    this.contentEl = document.createElement('div');
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
  }

  open(): void { this.onOpen(); }
  close(): void { this.onClose(); }

  onOpen(): void { /* override */ }
  onClose(): void { /* override */ }
}

export class PluginSettingTab {
  containerEl: HTMLElement;
  app: App;

  constructor(app: App, public readonly plugin: Plugin) {
    this.app = app;
    this.containerEl = document.createElement('div');
  }

  display(): void { /* override */ }
  hide(): void { /* override */ }
}

// ─── App / Plugin / Vault / FileSystemAdapter ────────────────────────

export interface Workspace {
  onLayoutReady(cb: () => void): void;
}

export class App {
  vault: Vault = new Vault();
  workspace: Workspace = { onLayoutReady: (cb) => cb() };
}

export class Vault {
  adapter: FileSystemAdapter = new FileSystemAdapter();
  configDir = '.obsidian';
  getName(): string { return 'TestVault'; }
}

export class FileSystemAdapter {
  private basePath = '/synthetic/vault';
  getBasePath(): string { return this.basePath; }
  setBasePath(p: string): void { this.basePath = p; }
}

export class Plugin {
  manifest = { id: 'remote-ssh', name: 'Remote SSH', version: '0.0.0', minAppVersion: '1.0.0', description: '', author: '', isDesktopOnly: true };
  app: App;

  constructor(app: App, manifest?: Partial<Plugin['manifest']>) {
    this.app = app;
    if (manifest) this.manifest = { ...this.manifest, ...manifest };
  }

  /** Test helper: returns the element so the harness can spy on its content. */
  addStatusBarItem(): HTMLElement {
    return document.createElement('div');
  }
  addCommand(): void { /* no-op for the harness */ }
  addSettingTab(): void { /* no-op */ }
}

// ─── requestUrl ──────────────────────────────────────────────────────
//
// Obsidian's cross-origin-friendly fetch wrapper. Actual HTTP calls
// are never made in unit tests — this stub throws so a mis-wired
// test fails loudly rather than silently hanging.

export async function requestUrl(_opts: unknown): Promise<{ text: string; json: unknown }> {
  throw new Error('requestUrl must be mocked in this test');
}

// ─── Re-exported types ───────────────────────────────────────────────
//
// The plugin uses `import type` for these elsewhere. Re-export so
// `import type { TFile } from 'obsidian'` resolves.

export type EventRef = symbol;
export type TFile = unknown;
export type TFolder = unknown;
export type TAbstractFile = unknown;
export type DataWriteOptions = unknown;
export type ListedFiles = unknown;
export type Stat = unknown;
export type CachedMetadata = unknown;
export type FrontMatterCache = unknown;
export type HeadingCache = unknown;
export type ListItemCache = unknown;
export type PluginManifest = Plugin['manifest'];

// Augment the global HTMLElement with the Obsidian DOM helpers so
// production source code typechecks against this mock.
declare global {
  interface HTMLElement {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      opts?: DomOptions,
      callback?: (el: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K];
    createDiv(opts?: DomOptions | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(opts?: DomOptions | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
    empty(): void;
    addClass(...classes: string[]): void;
    removeClass(...classes: string[]): void;
    setText(t: string | DocumentFragment): void;
    appendText(t: string): void;
    toggleClass(c: string | string[], on: boolean): void;
  }
}

// ─── Test helpers ────────────────────────────────────────────────────

/**
 * Find a button inside `root` by its visible text. Returns null if
 * absent. Use over `querySelectorAll('button').find(...)` boilerplate.
 */
export function findButton(root: HTMLElement, label: string): HTMLButtonElement | null {
  for (const b of Array.from(root.querySelectorAll('button'))) {
    if ((b.textContent ?? '').trim() === label) return b;
  }
  return null;
}

/**
 * Click a button by visible text. Throws if not found — silent
 * no-op tests are the bug we're avoiding.
 *
 * Drains a single microtask tick after the click. That is sufficient
 * for any onClick whose body is `await x; await y; …` over already-
 * resolved promises (V8 collapses the chained microtasks in one drain).
 * Handlers that schedule on `setTimeout` / `setImmediate`, or that
 * fire-and-forget a Promise without awaiting it, need a `vi.waitFor`
 * after the call instead.
 */
export async function clickButton(root: HTMLElement, label: string): Promise<void> {
  const b = findButton(root, label);
  if (!b) throw new Error(`clickButton: no button with label "${label}" under root`);
  b.click();
  await Promise.resolve();
}
