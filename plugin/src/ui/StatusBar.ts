import type { Plugin } from 'obsidian';
import { SyncState } from '../types';

const ICON: Record<SyncState, string> = {
  [SyncState.IDLE]:         '⬡',
  [SyncState.CONNECTING]:   '⟳',
  [SyncState.CONNECTED]:    '⬢',
  [SyncState.RECONNECTING]: '⟳',
  [SyncState.ERROR]:        '✕',
};

const LABEL: Record<SyncState, string> = {
  [SyncState.IDLE]:         'Remote SSH: Disconnected',
  [SyncState.CONNECTING]:   'Remote SSH: Connecting…',
  [SyncState.CONNECTED]:    'Remote SSH: Connected',
  [SyncState.RECONNECTING]: 'Remote SSH: Reconnecting…',
  [SyncState.ERROR]:        'Remote SSH: Error',
};

const CSS_CLASS: Partial<Record<SyncState, string>> = {
  [SyncState.CONNECTED]:    'is-connected',
  [SyncState.RECONNECTING]: 'is-reconnecting',
  [SyncState.ERROR]:        'is-error',
};

export class StatusBar {
  private el: HTMLElement;

  constructor(plugin: Plugin, private onClick: () => void) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass('remote-ssh-status');
    this.el.addEventListener('click', onClick);
    this.update(SyncState.IDLE);
  }

  update(state: SyncState, detail?: string) {
    this.el.setText(`${ICON[state]} ${detail ?? LABEL[state]}`);
    this.el.className = 'remote-ssh-status';
    const cls = CSS_CLASS[state];
    if (cls) this.el.addClass(cls);
  }

  remove() { this.el.remove(); }
}
