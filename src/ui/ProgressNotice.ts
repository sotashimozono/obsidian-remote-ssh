import { Notice } from 'obsidian';

export class ProgressNotice {
  private notice: Notice;
  private total: number;
  private done: number;
  private label: string;

  constructor(label: string, total: number) {
    this.label = label;
    this.total = total;
    this.done = 0;
    this.notice = new Notice(`${label}: 0/${total}`, 0);
  }

  increment() {
    this.done++;
    this.notice.setMessage(`${this.label}: ${this.done}/${this.total}`);
    if (this.done >= this.total) {
      setTimeout(() => this.notice.hide(), 2000);
    }
  }

  finish() {
    this.notice.hide();
  }
}
