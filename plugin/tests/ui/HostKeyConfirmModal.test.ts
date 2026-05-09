import { describe, it, expect } from 'vitest';
import { App } from 'obsidian';
import {
  HostKeyConfirmModal,
  type HostKeyConfirmInfo,
} from '../../src/ui/HostKeyConfirmModal';

const info: HostKeyConfirmInfo = {
  host: 'vault.example.com',
  port: 22,
  fingerprint: 'aabbccdd11223344556677889900aabb',
  keyType: 'ssh-ed25519',
};

function makeModal(overrides: Partial<HostKeyConfirmInfo> = {}) {
  return new HostKeyConfirmModal(new App(), { ...info, ...overrides });
}

describe('HostKeyConfirmModal — render', () => {
  it('shows the host and port in the body text', () => {
    const modal = makeModal();
    modal.open();
    const text = modal.contentEl.textContent ?? '';
    expect(text).toContain('vault.example.com');
    expect(text).toContain('22');
  });

  it('shows a formatted portion of the fingerprint', () => {
    const modal = makeModal();
    modal.open();
    const text = modal.contentEl.textContent ?? '';
    // formatFingerprint groups the hex into segments
    expect(text).toContain('aa');
  });

  it('shows the key type when provided', () => {
    const modal = makeModal({ keyType: 'ssh-ed25519' });
    modal.open();
    const text = modal.contentEl.textContent ?? '';
    expect(text).toContain('ssh-ed25519');
  });

  it('omits the key type row when keyType is undefined', () => {
    const modal = makeModal({ keyType: undefined });
    modal.open();
    const text = modal.contentEl.textContent ?? '';
    expect(text).not.toContain('Key type');
  });

  it('sets the modal title', () => {
    const modal = makeModal();
    modal.open();
    expect(modal.titleEl.textContent).toContain('Trust');
  });
});

describe('HostKeyConfirmModal — button decisions', () => {
  it('resolves "trust" when "Trust & remember" is clicked', async () => {
    const modal = makeModal();
    const p = modal.prompt();

    const btn = Array.from(modal.contentEl.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Trust & remember'),
    );
    expect(btn).toBeTruthy();
    btn!.click();

    await expect(p).resolves.toBe('trust');
  });

  it('resolves "trust-once" when "Trust this session only" is clicked', async () => {
    const modal = makeModal();
    const p = modal.prompt();

    const btn = Array.from(modal.contentEl.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Trust this session only'),
    );
    expect(btn).toBeTruthy();
    btn!.click();

    await expect(p).resolves.toBe('trust-once');
  });

  it('resolves "reject" when the "Reject" button is clicked', async () => {
    const modal = makeModal();
    const p = modal.prompt();

    const btn = Array.from(modal.contentEl.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Reject',
    );
    expect(btn).toBeTruthy();
    btn!.click();

    await expect(p).resolves.toBe('reject');
  });
});

describe('HostKeyConfirmModal — close without clicking a button', () => {
  it('resolves "reject" when closed via Escape / backdrop (no button click)', async () => {
    const modal = makeModal();
    const p = modal.prompt();
    modal.close();
    await expect(p).resolves.toBe('reject');
  });

  it('is idempotent — clicking trust and then closing resolves only "trust"', async () => {
    const modal = makeModal();
    const p = modal.prompt();

    const btn = Array.from(modal.contentEl.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Trust & remember'),
    );
    btn!.click();
    modal.close();

    await expect(p).resolves.toBe('trust');
  });

  it('empties contentEl on close', async () => {
    const modal = makeModal();
    // prompt() must be called first so that onChoice is initialised before
    // onClose() runs (the modal opens inside prompt() via this.open()).
    const p = modal.prompt();
    modal.close();
    await p; // resolves as 'reject' — just drain the promise
    expect(modal.contentEl.children.length).toBe(0);
  });
});
