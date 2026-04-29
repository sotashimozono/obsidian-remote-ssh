import { App, Modal } from 'obsidian';
import { diffLines, type DiffChunk } from '../conflict/DiffEngine';

/**
 * Outcome of the 3-way merge prompt:
 *
 * - `keep-mine` — write the local content as-is, overriding the
 *   remote version that landed during edit.
 * - `keep-theirs` — discard the local edit and adopt what the
 *   remote currently holds.
 * - `merged` — user hand-merged in the modal's editable pane;
 *   `content` is the result they want to write.
 * - `cancel` — user dismissed without choosing. The pending write
 *   should be aborted and the editor's buffer left dirty so the
 *   user can decide what to do.
 */
export type ThreeWayDecision =
  | { decision: 'keep-mine' }
  | { decision: 'keep-theirs' }
  | { decision: 'merged'; content: string }
  | { decision: 'cancel' };

export interface ThreeWayMergeInputs {
  /** Vault-relative path of the conflicting file, shown in the modal title. */
  path: string;
  /** Snapshot the user had open when they started typing. */
  ancestor: string;
  /** Content the user is trying to write. */
  mine: string;
  /** Content currently on the remote (what's there now). */
  theirs: string;
}

/**
 * Three-pane diff modal for write conflicts. Shown when an
 * `fs.write` is rejected with `PreconditionFailed` and an ancestor
 * snapshot is available. Plain-text only; binary conflicts continue
 * through the existing two-choice `WriteConflictModal`.
 *
 * Layout:
 *
 *   ┌─ Conflict at <path> ──────────────────────────┐
 *   │ ANCESTOR   │ MINE              │ THEIRS       │
 *   │ (read-only)│ (read-only,       │ (read-only,  │
 *   │            │  diff vs anc.)    │  diff vs anc.│
 *   ├────────────┴───────────────────┴──────────────┤
 *   │ Edit merged ▾ (collapsible)                    │
 *   │ ┌──────────────────────────────────────────┐   │
 *   │ │ <textarea pre-filled with mine>          │   │
 *   │ └──────────────────────────────────────────┘   │
 *   ├────────────────────────────────────────────────┤
 *   │ [Cancel] [Keep theirs] [Save merged] [Keep mine]│
 *   └────────────────────────────────────────────────┘
 *
 * Default focus is on "Keep mine" because that's the user's typed
 * intent — but the diff panes make it obvious whether the remote
 * edit is something they need to preserve.
 */
export class ThreeWayMergeModal extends Modal {
  private resolveDecision: ((d: ThreeWayDecision) => void) | null = null;
  private decisionSent = false;

  constructor(app: App, private readonly inputs: ThreeWayMergeInputs) {
    super(app);
  }

  prompt(): Promise<ThreeWayDecision> {
    return new Promise(resolve => {
      this.resolveDecision = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('remote-ssh-three-way-merge');

    contentEl.createEl('h2', { text: `Conflict at ${this.inputs.path}` });
    contentEl.createEl('p', {
      text:
        'The file changed on the remote while you were editing. Compare ' +
        'the panes below and pick how to resolve the conflict.',
    });

    // Diffs: lines added in mine vs ancestor (= what the user typed),
    // lines added in theirs vs ancestor (= what the remote got).
    const minesDiff  = diffLines(this.inputs.ancestor, this.inputs.mine);
    const theirsDiff = diffLines(this.inputs.ancestor, this.inputs.theirs);

    const panes = contentEl.createDiv({ cls: 'remote-ssh-merge-panes' });

    renderPane(panes, 'Ancestor (your starting point)', this.inputs.ancestor.split('\n').map(line => ({ kind: 'eq', lines: [line] })));
    renderPane(panes, 'Mine (what you typed)',           minesDiff);
    renderPane(panes, 'Theirs (current remote)',         theirsDiff);

    // Collapsible "Edit merged" textarea — pre-filled with mine
    // because that's the content the user typed. They can paste / edit
    // freely; clicking "Save merged" writes the textarea contents.
    const mergeWrapper = contentEl.createDiv({ cls: 'remote-ssh-merge-edit' });
    const mergeToggle = mergeWrapper.createEl('details');
    mergeToggle.createEl('summary', { text: 'Edit merged content (advanced)' });
    const mergeArea = mergeToggle.createEl('textarea', { cls: 'remote-ssh-merge-textarea' });
    mergeArea.value = this.inputs.mine;

    const buttons = contentEl.createDiv({ cls: 'remote-ssh-merge-buttons' });

    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.send({ decision: 'cancel' });
      this.close();
    });

    const keepTheirsBtn = buttons.createEl('button', { text: 'Keep theirs' });
    keepTheirsBtn.addEventListener('click', () => {
      this.send({ decision: 'keep-theirs' });
      this.close();
    });

    const saveMergedBtn = buttons.createEl('button', { text: 'Save merged' });
    saveMergedBtn.addEventListener('click', () => {
      this.send({ decision: 'merged', content: mergeArea.value });
      this.close();
    });

    const keepMineBtn = buttons.createEl('button', { text: 'Keep mine', cls: 'mod-cta' });
    keepMineBtn.addEventListener('click', () => {
      this.send({ decision: 'keep-mine' });
      this.close();
    });
  }

  onClose(): void {
    // Dismiss-via-Escape / outside-click defaults to cancel — same
    // posture as a user clicking the Cancel button. The pending
    // write is held back rather than silently picking a side.
    if (!this.decisionSent) this.send({ decision: 'cancel' });
    this.contentEl.empty();
  }

  private send(decision: ThreeWayDecision): void {
    if (this.decisionSent) return;
    this.decisionSent = true;
    this.resolveDecision?.(decision);
  }
}

/**
 * Render one pane: a heading + a scrollable monospace block where each
 * `del` line is shown with a strikethrough background and each `add`
 * line with a green background. `eq` lines render as-is. Empty input
 * shows "(empty)" so the user can tell the file is intentionally
 * blank rather than a render bug.
 */
function renderPane(parent: HTMLElement, title: string, chunks: DiffChunk[]): void {
  const pane = parent.createDiv({ cls: 'remote-ssh-merge-pane' });

  pane.createDiv({ text: title, cls: 'remote-ssh-merge-pane-header' });

  const body = pane.createEl('pre', { cls: 'remote-ssh-merge-pane-body' });

  if (chunks.length === 0) {
    body.createSpan({ text: '(empty)', cls: 'remote-ssh-merge-pane-empty' });
    return;
  }

  for (const chunk of chunks) {
    const line = body.createSpan({ cls: 'remote-ssh-merge-line' });
    line.textContent = chunk.lines.join('\n') + '\n';
    if (chunk.kind === 'add') {
      line.addClass('is-add');
    } else if (chunk.kind === 'del') {
      line.addClass('is-del');
    }
  }
}
