import { Modal, App, Notice, Setting } from 'obsidian';
import { SftpClient } from '../ssh/SftpClient';
import type { AuthResolver } from '../ssh/AuthResolver';
import type { HostKeyStore } from '../ssh/HostKeyStore';
import type { SshProfile, RemoteEntry } from '../types';
import { errorMessage } from '../util/errorMessage';

/**
 * Modal that connects SSH and lets the user browse the remote filesystem
 * to pick a vault directory. Starts at `$HOME` and shows folders only.
 */
export class RemotePathBrowserModal extends Modal {
  private client: SftpClient | null = null;
  private currentPath = '';
  private homePath = '';
  private loading = false;

  constructor(
    app: App,
    private readonly profile: SshProfile,
    private readonly authResolver: AuthResolver,
    private readonly hostKeyStore: HostKeyStore,
    private readonly onSelect: (path: string) => void,
  ) {
    super(app);
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('remote-ssh-path-browser');
    this.renderConnecting();

    try {
      this.client = new SftpClient(this.authResolver, this.hostKeyStore);
      await this.client.connect(this.profile);
      this.homePath = await this.client.getRemoteHome();
      this.currentPath = this.homePath;
      await this.renderDirectory();
    } catch (e) {
      this.renderError(`Connection failed: ${errorMessage(e)}`);
    }
  }

  onClose() {
    this.contentEl.empty();
    if (this.client?.isAlive()) {
      void this.client.disconnect().catch(() => {});
    }
    this.client = null;
  }

  private renderConnecting() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Browse remote' });
    contentEl.createEl('p', { text: `Connecting to ${this.profile.host}…` });
  }

  private renderError(message: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Browse remote' });
    contentEl.createEl('p', { text: message, cls: 'mod-warning' });
    contentEl.createEl('button', { text: 'Close' }).onclick = () => this.close();
  }

  private async renderDirectory() {
    if (!this.client || this.loading) return;
    this.loading = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Browse remote' });

    // Breadcrumb
    const breadcrumb = contentEl.createDiv({ cls: 'remote-ssh-breadcrumb' });
    const displayPath = this.toDisplayPath(this.currentPath);
    const parts = displayPath === '~' ? [] : displayPath.replace(/^~\//, '').split('/').filter(Boolean);
    const isHomeBased = displayPath.startsWith('~');

    const homeLink = breadcrumb.createEl('span', {
      text: isHomeBased ? '~' : '/',
      cls: 'remote-ssh-breadcrumb-segment',
    });
    homeLink.onclick = () => {
      this.currentPath = isHomeBased ? this.homePath : '/';
      void this.renderDirectory();
    };

    let accumulated = isHomeBased ? this.homePath : '';
    for (const part of parts) {
      breadcrumb.createEl('span', { text: ' / ' });
      accumulated += (accumulated.endsWith('/') ? '' : '/') + part;
      const targetPath = accumulated;
      const seg = breadcrumb.createEl('span', { text: part, cls: 'remote-ssh-breadcrumb-segment' });
      seg.onclick = () => {
        this.currentPath = targetPath;
        void this.renderDirectory();
      };
    }

    // Directory listing
    const listContainer = contentEl.createDiv({ cls: 'remote-ssh-dir-list' });
    let entries: RemoteEntry[];
    try {
      entries = await this.client.list(this.currentPath);
    } catch (e) {
      listContainer.createEl('p', { text: `Failed to list: ${errorMessage(e)}`, cls: 'mod-warning' });
      this.loading = false;
      return;
    }

    const folders = entries
      .filter(e => e.isDirectory && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Parent directory
    if (this.currentPath !== '/' && this.currentPath !== '') {
      const parentItem = listContainer.createDiv({ cls: 'remote-ssh-dir-item' });
      parentItem.createEl('span', { text: '📁 ..' });
      parentItem.onclick = () => {
        const lastSlash = this.currentPath.lastIndexOf('/');
        this.currentPath = lastSlash <= 0 ? '/' : this.currentPath.slice(0, lastSlash);
        void this.renderDirectory();
      };
    }

    if (folders.length === 0) {
      listContainer.createEl('p', { text: '(no subdirectories)', cls: 'setting-item-description' });
    }

    for (const folder of folders) {
      const item = listContainer.createDiv({ cls: 'remote-ssh-dir-item' });
      item.createEl('span', { text: `📁 ${folder.name}` });
      item.onclick = () => {
        this.currentPath = this.currentPath === '/'
          ? `/${folder.name}`
          : `${this.currentPath}/${folder.name}`;
        void this.renderDirectory();
      };
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'remote-ssh-path-actions' });

    new Setting(actions)
      .setName(`Selected: ${this.toDisplayPath(this.currentPath)}`)
      .addButton(btn => btn
        .setButtonText('Use this folder')
        .setCta()
        .onClick(() => {
          this.onSelect(this.toDisplayPath(this.currentPath));
          this.close();
        }))
      .addButton(btn => btn
        .setButtonText('New folder…')
        .onClick(() => this.promptNewFolder()))
      .addButton(btn => btn
        .setButtonText('Cancel')
        .onClick(() => this.close()));

    this.loading = false;
  }

  private async promptNewFolder() {
    if (!this.client) return;
    const name = prompt('New folder name:');
    if (!name?.trim()) return;
    const newPath = this.currentPath === '/'
      ? `/${name.trim()}`
      : `${this.currentPath}/${name.trim()}`;
    try {
      await this.client.mkdirp(newPath);
      this.currentPath = newPath;
      await this.renderDirectory();
    } catch (e) {
      new Notice(`Failed to create folder: ${errorMessage(e)}`);
    }
  }

  /** Convert absolute path to `~/relative` when under $HOME. */
  private toDisplayPath(absPath: string): string {
    if (this.homePath && absPath.startsWith(this.homePath)) {
      const rel = absPath.slice(this.homePath.length);
      if (rel === '' || rel === '/') return '~';
      return '~' + (rel.startsWith('/') ? rel : '/' + rel);
    }
    return absPath || '/';
  }
}
