import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertObsidianVault, NotAnObsidianVaultError, VaultNotAllowedError } from '../vault-guard.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-vault-guard-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('assertObsidianVault', () => {
  it('.obsidianディレクトリがある許可vaultだけを通す', async () => {
    const vault = path.join(tmpDir, 'vault');
    await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });

    await expect(assertObsidianVault(vault, { allowedVaultRoots: [vault] })).resolves.toBe(await fs.realpath(vault));
  });

  it('.obsidianがなければ拒否する', async () => {
    const notVault = path.join(tmpDir, 'not-vault');
    await fs.mkdir(notVault, { recursive: true });

    await expect(assertObsidianVault(notVault)).rejects.toBeInstanceOf(NotAnObsidianVaultError);
  });

  it('許可リストにないvaultは拒否する', async () => {
    const allowed = path.join(tmpDir, 'allowed');
    const denied = path.join(tmpDir, 'denied');
    await fs.mkdir(path.join(allowed, '.obsidian'), { recursive: true });
    await fs.mkdir(path.join(denied, '.obsidian'), { recursive: true });

    await expect(assertObsidianVault(denied, { allowedVaultRoots: [allowed] })).rejects.toBeInstanceOf(VaultNotAllowedError);
  });

  it('.obsidianがsymlinkなら拒否する', async () => {
    const realConfig = path.join(tmpDir, 'real-obsidian');
    const vault = path.join(tmpDir, 'vault');
    await fs.mkdir(realConfig, { recursive: true });
    await fs.mkdir(vault, { recursive: true });
    await fs.symlink(realConfig, path.join(vault, '.obsidian'), 'dir');

    await expect(assertObsidianVault(vault)).rejects.toBeInstanceOf(NotAnObsidianVaultError);
  });
});
