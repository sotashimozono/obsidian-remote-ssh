import type { Plugin } from 'obsidian';
import { SyncState } from '../types';

const ICON: Record<SyncState, string> = {
  [SyncState.IDLE]:          '⬡',
  [SyncState.CONNECTING]:    '⟳',
  [SyncState.INITIAL_PULL]:  '⇩',
  [SyncState.WATCHING]:      '⬢',
  [SyncState.SYNCING]:       '⟳',
  [SyncState.CONFLICTED]:    '⚠',
  [SyncState.DISCONNECTING]: '⟳',
  [SyncState.ERROR]:         '✕',
};

const LABEL: Record<SyncState, string> = {
  [SyncState.IDLE]:          'Remote SSH: Disconnected',
  [SyncState.CONNECTING]:    'Remote SSH: Connecting…',
  [SyncState.INITIAL_PULL]:  'Remote SSH: Pulling…',
  [SyncState.WATCHING]:      'Remote SSH: Connected',
  [SyncState.SYNCING]:       'Remote SSH: Syncing…',
  [SyncState.CONFLICTED]:    'Remote SSH: Conflict!',
  [SyncState.DISCONNECTING]: 'Remote SSH: Disconnecting…',
  [SyncState.ERROR]:         'Remote SSH: Error',
};

const CSS_CLASS: Partial<Record<SyncState, string>> = {
  [SyncState.WATCHING]:  'is-connected',
  [SyncState.SYNCING]:   'is-syncing',
  [SyncState.ERROR]:     'is-error',
  [SyncState.CONFLICTED]:'is-error',
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
