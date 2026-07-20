import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCredentials, loadCredentials, saveCredentials } from '../credentials.js';
import { atomicWriteHomeStateFile, readHomeStateFile } from '../local-state-io.js';

let testRoot: string;
let homePath: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-credentials-'));
  homePath = path.join(testRoot, 'home');
  await fs.mkdir(homePath);
  vi.spyOn(os, 'homedir').mockReturnValue(homePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('credentials local storage', () => {
  it('~/.o2nを0700、credentials.jsonを0600で保存する', async () => {
    const credentials = { token: 'secret-token', savedAt: '2026-07-20T00:00:00Z' };
    await saveCredentials(credentials);

    expect(await loadCredentials()).toEqual(credentials);
    const directoryStat = await fs.stat(path.join(homePath, '.o2n'));
    const fileStat = await fs.stat(path.join(homePath, '.o2n', 'credentials.json'));
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('~/.o2n自体がsymlinkなら資格情報を外部へ保存しない', async () => {
    const outsideDirectory = path.join(testRoot, 'outside');
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, path.join(homePath, '.o2n'));

    await expect(
      saveCredentials({ token: 'secret-token', savedAt: '2026-07-20T00:00:00Z' }),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(outsideDirectory, 'credentials.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('credentials.json symlinkの読込み・保存・削除を拒否する', async () => {
    const outsideCredentials = path.join(testRoot, 'outside-credentials.json');
    await fs.writeFile(outsideCredentials, '{"token":"outside"}');
    await fs.mkdir(path.join(homePath, '.o2n'), { mode: 0o700 });
    await fs.symlink(outsideCredentials, path.join(homePath, '.o2n', 'credentials.json'));

    await expect(loadCredentials()).rejects.toThrow();
    await expect(
      saveCredentials({ token: 'replacement', savedAt: '2026-07-20T00:00:00Z' }),
    ).rejects.toThrow();
    await expect(clearCredentials()).rejects.toThrow();
    expect(await fs.readFile(outsideCredentials, 'utf-8')).toBe('{"token":"outside"}');
  });

  it('clearCredentialsはENOENTだけを無視する', async () => {
    await expect(clearCredentials()).resolves.toBeUndefined();
    await fs.mkdir(path.join(homePath, '.o2n'), { mode: 0o700 });
    await fs.mkdir(path.join(homePath, '.o2n', 'credentials.json'));
    await expect(clearCredentials()).rejects.toThrow();
  });

  it('state-signing-key symlinkの読込み・保存を拒否する', async () => {
    const outsideKey = path.join(testRoot, 'outside-signing-key');
    await fs.writeFile(outsideKey, 'attacker-key');
    await fs.mkdir(path.join(homePath, '.o2n'), { mode: 0o700 });
    await fs.symlink(outsideKey, path.join(homePath, '.o2n', 'state-signing-key'));

    await expect(readHomeStateFile('state-signing-key')).rejects.toThrow();
    await expect(
      atomicWriteHomeStateFile('state-signing-key', 'replacement-key'),
    ).rejects.toThrow();
    expect(await fs.readFile(outsideKey, 'utf-8')).toBe('attacker-key');
  });
});
