import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCredentials, loadCredentials, saveCredentials } from '../credentials.js';
import { atomicWriteHomeStateFile, readHomeStateFile } from '../local-state-io.js';

let testRoot: string;
let homePath: string;

beforeEach(async () => {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-credentials-'));
  testRoot = await fs.realpath(createdRoot);
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

  it('legacy 0755 ~/.o2nを0700へ縮小してcredentialsを読める', async () => {
    const directoryPath = path.join(homePath, '.o2n');
    const credentials = { token: 'legacy-token', savedAt: '2026-07-20T00:00:00Z' };
    await fs.mkdir(directoryPath, { mode: 0o755 });
    await fs.writeFile(
      path.join(directoryPath, 'credentials.json'),
      JSON.stringify(credentials),
      { mode: 0o600 },
    );
    await fs.chmod(directoryPath, 0o755);

    await expect(loadCredentials()).resolves.toEqual(credentials);
    expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);
  });

  it('legacy 0755 ~/.o2nを0700へ縮小してsigning keyを読める', async () => {
    const directoryPath = path.join(homePath, '.o2n');
    await fs.mkdir(directoryPath, { mode: 0o755 });
    await fs.writeFile(path.join(directoryPath, 'state-signing-key'), 'legacy-key', { mode: 0o600 });
    await fs.chmod(directoryPath, 0o755);

    await expect(readHomeStateFile('state-signing-key')).resolves.toBe('legacy-key');
    expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);
  });

  it('legacy 0755 ~/.o2nを縮小してhome secretsを書ける', async () => {
    const directoryPath = path.join(homePath, '.o2n');
    await fs.mkdir(directoryPath, { mode: 0o755 });
    await fs.chmod(directoryPath, 0o755);

    await saveCredentials({ token: 'new-token', savedAt: '2026-07-20T00:00:00Z' });
    await atomicWriteHomeStateFile('state-signing-key', 'new-key');

    expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(directoryPath, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(directoryPath, 'state-signing-key'))).mode & 0o777).toBe(0o600);
  });

  it.each([0o775, 0o777])(
    'group/other writableなlegacy ~/.o2n (%o)を拒否する',
    async (legacyMode) => {
      const directoryPath = path.join(homePath, '.o2n');
      await fs.mkdir(directoryPath, { mode: 0o700 });
      await fs.chmod(directoryPath, legacyMode);

      await expect(
        saveCredentials({ token: 'secret', savedAt: '2026-07-20T00:00:00Z' }),
      ).rejects.toThrow();
      expect((await fs.stat(directoryPath)).mode & 0o777).toBe(legacyMode);
    },
  );

  it('legacy ~/.o2n mode縮小直前のidentity raceを拒否する', async () => {
    const directoryPath = path.join(homePath, '.o2n');
    const movedDirectory = path.join(homePath, '.o2n-before-tighten');
    await fs.mkdir(directoryPath, { mode: 0o755 });
    await fs.chmod(directoryPath, 0o755);

    await expect(
      atomicWriteHomeStateFile('credentials.json', '{}', {
        testHooks: {
          beforeDirectoryModeTighten: async () => {
            await fs.rename(directoryPath, movedDirectory);
            await fs.mkdir(directoryPath, { mode: 0o755 });
          },
        },
      }),
    ).rejects.toThrow();

    expect((await fs.stat(movedDirectory)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(typeof process.geteuid !== 'function')(
    '期待UIDと異なるlegacy home treeを移行しない',
    async () => {
      const directoryPath = path.join(homePath, '.o2n');
      await fs.mkdir(directoryPath, { mode: 0o755 });
      await fs.writeFile(path.join(directoryPath, 'state-signing-key'), 'key', { mode: 0o600 });
      await fs.chmod(directoryPath, 0o755);

      await expect(
        readHomeStateFile('state-signing-key', { expectedUid: process.geteuid!() + 1 }),
      ).rejects.toThrow();
      expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o755);
    },
  );

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

  it.each(['credentials.json', 'state-signing-key'] as const)(
    'O_NOFOLLOWなしでも%s symlinkの読取りを拒否する',
    async (fileName) => {
      const outsideFile = path.join(testRoot, `outside-${fileName}`);
      await fs.writeFile(outsideFile, 'outside secret');
      await fs.mkdir(path.join(homePath, '.o2n'), { mode: 0o700 });
      await fs.symlink(outsideFile, path.join(homePath, '.o2n', fileName));

      await expect(
        readHomeStateFile(fileName, { noFollowFlag: 0 }),
      ).rejects.toThrow();
    },
  );

  it.each(['credentials.json', 'state-signing-key'] as const)(
    '%sがhardlinkなら読取りを拒否する',
    async (fileName) => {
      const secretPath = path.join(homePath, '.o2n', fileName);
      await fs.mkdir(path.dirname(secretPath), { mode: 0o700 });
      await fs.writeFile(secretPath, 'secret', { mode: 0o600 });
      await fs.link(secretPath, path.join(testRoot, `${fileName}.hardlink`));

      await expect(readHomeStateFile(fileName)).rejects.toThrow();
    },
  );

  it.each(['credentials.json', 'state-signing-key'] as const)(
    '%sが0644なら読取りを拒否する',
    async (fileName) => {
      const secretPath = path.join(homePath, '.o2n', fileName);
      await fs.mkdir(path.dirname(secretPath), { mode: 0o700 });
      await fs.writeFile(secretPath, 'secret', { mode: 0o600 });
      await fs.chmod(secretPath, 0o644);

      await expect(readHomeStateFile(fileName)).rejects.toThrow();
    },
  );

  it.skipIf(typeof process.geteuid !== 'function')(
    '秘密ファイルが期待したuser所有でなければ読取りを拒否する',
    async () => {
      const secretPath = path.join(homePath, '.o2n', 'state-signing-key');
      await fs.mkdir(path.dirname(secretPath), { mode: 0o700 });
      await fs.writeFile(secretPath, 'secret', { mode: 0o600 });
      const currentUid = process.geteuid!();

      await expect(
        readHomeStateFile('state-signing-key', { expectedFileUid: currentUid + 1 }),
      ).rejects.toThrow();
    },
  );

  it('~/.o2nがgroup/other書込み可能なら秘密を読まない', async () => {
    const directoryPath = path.join(homePath, '.o2n');
    await fs.mkdir(directoryPath, { mode: 0o700 });
    await fs.writeFile(path.join(directoryPath, 'state-signing-key'), 'secret', { mode: 0o600 });
    await fs.chmod(directoryPath, 0o777);

    await expect(readHomeStateFile('state-signing-key')).rejects.toThrow();
  });

  it('home上位のuser-owned 0777 non-sticky ancestorを拒否する', async () => {
    const writableAncestor = path.join(testRoot, 'writable-home-parent');
    const untrustedHome = path.join(writableAncestor, 'home');
    await fs.mkdir(untrustedHome, { recursive: true });
    await fs.chmod(writableAncestor, 0o777);
    vi.mocked(os.homedir).mockReturnValue(untrustedHome);

    await expect(
      saveCredentials({ token: 'secret', savedAt: '2026-07-20T00:00:00Z' }),
    ).rejects.toThrow();
  });

  it('0600かつ単一linkの秘密ファイルは正常に読める', async () => {
    const directoryPath = path.join(homePath, '.o2n');
    await fs.mkdir(directoryPath, { mode: 0o700 });
    await fs.writeFile(path.join(directoryPath, 'state-signing-key'), 'secret', { mode: 0o600 });

    await expect(readHomeStateFile('state-signing-key')).resolves.toBe('secret');
  });
});
