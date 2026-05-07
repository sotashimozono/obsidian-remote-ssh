import { App, findButton } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { HostKeyConfirmModal } from '../src/ui/HostKeyConfirmModal';

function makeModal(): HostKeyConfirmModal {
  return new HostKeyConfirmModal(new App(), {
    host: 'example.com',
    port: 22,
    fingerprint: 'a'.repeat(64),
    keyType: 'ssh-ed25519',
  });
}

describe('HostKeyConfirmModal', () => {
  it('renders host details and key type on open', () => {
    const modal = makeModal();
    modal.onOpen();
    expect(modal.titleEl.textContent).toBe('Trust remote host key?');
    expect(modal.contentEl.textContent).toContain('example.com:22');
    expect(modal.contentEl.textContent).toContain('ssh-ed25519');
  });

  it('does not render key type row when keyType is omitted', () => {
    const modal = new HostKeyConfirmModal(new App(), {
      host: 'example.com',
      port: 22,
      fingerprint: 'b'.repeat(64),
    });
    modal.onOpen();
    expect(modal.contentEl.textContent).not.toContain('Key type:');
  });

  it('prompt resolves trust-once when that button is clicked', async () => {
    const modal = makeModal();
    const decisionPromise = modal.prompt();
    await Promise.resolve();
    findButton(modal.contentEl, 'Trust this session only')?.click();
    await expect(decisionPromise).resolves.toBe('trust-once');
  });

  it('prompt resolves trust when Trust & remember button is clicked', async () => {
    const modal = makeModal();
    const decisionPromise = modal.prompt();
    await Promise.resolve();
    findButton(modal.contentEl, 'Trust & remember')?.click();
    await expect(decisionPromise).resolves.toBe('trust');
  });

  it('prompt resolves reject when Reject button is clicked', async () => {
    const modal = makeModal();
    const decisionPromise = modal.prompt();
    await Promise.resolve();
    findButton(modal.contentEl, 'Reject')?.click();
    await expect(decisionPromise).resolves.toBe('reject');
  });

  it('resolves reject when closed without explicit choice', async () => {
    const modal = makeModal();
    const decisionPromise = modal.prompt();
    await Promise.resolve();
    modal.close();
    await expect(decisionPromise).resolves.toBe('reject');
  });

  it('resolved flag prevents onClose from overwriting an explicit choice', async () => {
    const modal = makeModal();
    const decisionPromise = modal.prompt();
    await Promise.resolve();
    findButton(modal.contentEl, 'Trust this session only')?.click(); // sets resolved = true, closes modal
    modal.close(); // onClose fires again but should be no-op
    await expect(decisionPromise).resolves.toBe('trust-once');
  });
});
