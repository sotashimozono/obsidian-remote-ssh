import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { wireKeyboardInteractiveHandler } from '../src/ssh/SftpClient';
import type { KbdInteractiveHandlerFn } from '../src/ssh/SftpClient';

/**
 * Emit a keyboard-interactive event on the fake client, matching ssh2's
 * signature: (name, instructions, lang, prompts[], finish).
 */
function emitKbdInteractive(
  client: EventEmitter,
  prompts: Array<{ prompt: string; echo?: boolean }>,
): Promise<string[]> {
  return new Promise((resolve) => {
    const finish = (responses: string[]) => resolve(responses);
    client.emit(
      'keyboard-interactive',
      'auth-name',
      'Enter your code',
      '',
      prompts,
      finish,
    );
  });
}

describe('wireKeyboardInteractiveHandler', () => {
  it('normalises prompts where echo is undefined to echo: false', async () => {
    const client = new EventEmitter();
    const received: Array<{ prompt: string; echo: boolean }>[] = [];
    const handler: KbdInteractiveHandlerFn = async (prompts) => {
      received.push(prompts);
      return prompts.map(() => '123456');
    };

    wireKeyboardInteractiveHandler(client, handler);
    await emitKbdInteractive(client, [
      { prompt: 'TOTP: ' },
      { prompt: 'Password: ', echo: true },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([
      { prompt: 'TOTP: ', echo: false },
      { prompt: 'Password: ', echo: true },
    ]);
  });

  it('forwards handler responses to finish()', async () => {
    const client = new EventEmitter();
    const handler: KbdInteractiveHandlerFn = async () => ['abc', 'def'];

    wireKeyboardInteractiveHandler(client, handler);
    const responses = await emitKbdInteractive(client, [
      { prompt: 'Code: ' },
      { prompt: 'PIN: ' },
    ]);

    expect(responses).toEqual(['abc', 'def']);
  });

  it('treats null (cancel) as empty array → finish([])', async () => {
    const client = new EventEmitter();
    const handler: KbdInteractiveHandlerFn = async () => null;

    wireKeyboardInteractiveHandler(client, handler);
    const responses = await emitKbdInteractive(client, [
      { prompt: 'Code: ' },
    ]);

    expect(responses).toEqual([]);
  });

  it('catches handler errors and calls finish([]) with a warning log', async () => {
    const client = new EventEmitter();
    const { logger } = await import('../src/util/logger');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const handler: KbdInteractiveHandlerFn = async () => {
      throw new Error('modal crashed');
    };

    wireKeyboardInteractiveHandler(client, handler);
    const responses = await emitKbdInteractive(client, [
      { prompt: 'Code: ' },
    ]);

    expect(responses).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('modal crashed'),
    );
    warnSpy.mockRestore();
  });

  it('handles multi-prompt rounds correctly', async () => {
    const client = new EventEmitter();
    const handler: KbdInteractiveHandlerFn = async (prompts) => {
      return prompts.map((_, i) => `answer-${i}`);
    };

    wireKeyboardInteractiveHandler(client, handler);
    const responses = await emitKbdInteractive(client, [
      { prompt: 'Username: ', echo: true },
      { prompt: 'Password: ' },
      { prompt: 'TOTP: ' },
    ]);

    expect(responses).toEqual(['answer-0', 'answer-1', 'answer-2']);
  });
});
