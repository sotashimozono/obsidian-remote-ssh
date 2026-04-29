import { App, Modal, Setting } from 'obsidian';
import type { PendingPluginSuggestion } from '../types';

/**
 * Outcome of the pending-plugins prompt:
 *
 * - `decision: 'install'` — user reviewed the list and clicked
 *   "Install selected". `selected` is the subset of suggestion ids
 *   they kept ticked; `copyConfig` is whether to also seed each
 *   installed plugin's `data.json` from the source vault snapshot.
 * - `decision: 'skip'` — user clicked "Skip — install nothing".
 *   The shadow window should clear `pendingPluginSuggestions` so
 *   we don't ask again.
 * - `decision: 'later'` — user dismissed the modal (clicked "Ask
 *   later" or pressed Escape). `pendingPluginSuggestions` stays
 *   in place; the modal returns on the next shadow-window reload.
 */
export type PendingPluginsDecision =
  | { decision: 'install'; selected: string[]; copyConfig: boolean }
  | { decision: 'skip' }
  | { decision: 'later' };

/**
 * Modal that surfaces the source vault's enabled community plugins
 * and lets the user pick which (if any) to install in this shadow
 * vault from Obsidian's community marketplace.
 *
 * Usage:
 *
 *   const decision = await new PendingPluginsModal(app, suggestions).prompt();
 *   if (decision.decision === 'install') { … run installer for decision.selected … }
 *
 * Defaults: every plugin is checked, "copy local config" is OFF.
 * The user reviews the list, unchecks anything they don't want,
 * optionally turns on config inheritance, and clicks Install.
 */
export class PendingPluginsModal extends Modal {
  private resolveDecision: ((d: PendingPluginsDecision) => void) | null = null;
  private decisionSent = false;

  constructor(app: App, private readonly suggestions: ReadonlyArray<PendingPluginSuggestion>) {
    super(app);
  }

  prompt(): Promise<PendingPluginsDecision> {
    return new Promise(resolve => {
      this.resolveDecision = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Install plugins from your source vault?' });
    contentEl.createEl('p', {
      text:
        `Your source vault has ${this.suggestions.length} community plugin` +
        `${this.suggestions.length === 1 ? '' : 's'} enabled. Pick which to install in this ` +
        'shadow vault — they will be downloaded fresh from the Obsidian community ' +
        'marketplace. Nothing is installed unless you click "Install selected".',
    });

    // All ticked by default — user reviews and unticks.
    const checkedIds = new Set(this.suggestions.map(s => s.id));

    const list = contentEl.createDiv({ cls: 'remote-ssh-pending-plugins' });

    for (const suggestion of this.suggestions) {
      const row = list.createDiv({ cls: 'remote-ssh-pending-plugin-row' });

      const cb = row.createEl('input', { type: 'checkbox', cls: 'remote-ssh-pending-plugin-checkbox' });
      cb.checked = true;
      cb.addEventListener('change', () => {
        if (cb.checked) checkedIds.add(suggestion.id);
        else            checkedIds.delete(suggestion.id);
      });

      const label = row.createEl('label', { text: suggestion.id, cls: 'remote-ssh-pending-plugin-label' });
      label.addEventListener('click', () => { cb.click(); });

      if (suggestion.sourceData != null) {
        row.createEl('span', { text: 'has settings', cls: 'remote-ssh-pending-plugin-tag' });
      }
    }

    let copyConfig = false;
    new Setting(contentEl)
      .setName('Also copy each plugin\'s settings (data.json) from source')
      .setDesc(
        'When on, the source vault\'s per-plugin settings are seeded into the shadow ' +
        'vault for each installed plugin. Off by default — installed plugins start with ' +
        'their out-of-the-box defaults.',
      )
      .addToggle(t => t.setValue(copyConfig).onChange(v => { copyConfig = v; }));

    const buttons = contentEl.createDiv({ cls: 'remote-ssh-pending-buttons' });

    const askLaterBtn = buttons.createEl('button', { text: 'Ask later' });
    askLaterBtn.addEventListener('click', () => {
      this.send({ decision: 'later' });
      this.close();
    });

    const skipBtn = buttons.createEl('button', { text: 'Skip — install nothing' });
    skipBtn.addEventListener('click', () => {
      this.send({ decision: 'skip' });
      this.close();
    });

    const installBtn = buttons.createEl('button', { text: 'Install selected', cls: 'mod-cta' });
    installBtn.addEventListener('click', () => {
      this.send({
        decision: 'install',
        selected: Array.from(checkedIds),
        copyConfig,
      });
      this.close();
    });
  }

  onClose(): void {
    // If the user dismissed via Escape / outside-click without
    // pressing a button, treat it as "ask later" — leave the
    // pendingPluginSuggestions in place for next reload.
    if (!this.decisionSent) this.send({ decision: 'later' });
    this.contentEl.empty();
  }

  private send(decision: PendingPluginsDecision): void {
    if (this.decisionSent) return;
    this.decisionSent = true;
    this.resolveDecision?.(decision);
  }
}
