import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotionApiError } from '@tk_wfl/o2n-core';
import { loginWithTokenCommand } from './login-token.js';

const now = () => new Date('2026-09-27T00:00:00Z');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('o2n login --token (#164)', () => {
  it('入力されたトークンを確認してから保存する（前後の空白は除く）', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const verify = vi.fn().mockResolvedValue({ workspaceName: 'My WS' });
    const code = await loginWithTokenCommand({ readToken: async () => '  ntn_abc123\n', verify, save, now });
    expect(code).toBe(0);
    expect(verify).toHaveBeenCalledWith('ntn_abc123');
    expect(save).toHaveBeenCalledWith({ token: 'ntn_abc123', workspaceName: 'My WS', savedAt: '2026-09-27T00:00:00.000Z' });
  });

  it('無効なトークン（401）は保存しない', async () => {
    const save = vi.fn();
    const verify = vi.fn().mockRejectedValue(new NotionApiError(401, 'unauthorized', 'API token is invalid.'));
    const code = await loginWithTokenCommand({ readToken: async () => 'ntn_bad', verify, save, now });
    expect(code).toBe(2);
    expect(save).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('401');
  });

  it.each(['', '   ', 'ntn a b', 'x'.repeat(513)])('空・空白入り・長すぎる入力 %# は確認せずに断る', async (input) => {
    const save = vi.fn();
    const verify = vi.fn();
    const code = await loginWithTokenCommand({ readToken: async () => input, verify, save, now });
    expect(code).toBe(2);
    expect(verify).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('ワークスペース名の制御文字を取り除いてから保存・表示する', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await loginWithTokenCommand({
      readToken: async () => 'ntn_ok',
      verify: async () => ({ workspaceName: 'WS\u001b[31mRed' }),
      save,
      now,
    });
    expect(save.mock.calls[0][0].workspaceName).toBe('WS[31mRed');
  });

  it('入力のキャンセルは失敗として終わる', async () => {
    const save = vi.fn();
    const code = await loginWithTokenCommand({
      readToken: async () => {
        throw new Error('入力をキャンセルしました。');
      },
      save,
      now,
    });
    expect(code).toBe(2);
    expect(save).not.toHaveBeenCalled();
  });
});
