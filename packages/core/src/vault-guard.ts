import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * セキュリティ対策（外部レビュー指摘対応）: MCPサーバーはAIエージェント経由で任意の
 * vaultPathを渡されうるため、実際にObsidian vaultらしいディレクトリであることを
 * 検証してから読み取り・書き込みを行う。`.obsidian`ディレクトリの存在で判定する
 * （Obsidianが自動生成する設定ディレクトリで、通常のvaultには必ず存在する）。
 * これにより `~/.ssh` 等の無関係なディレクトリを誤って（あるいはプロンプト
 * インジェクションにより意図的に）走査・送信されることを防ぐ。
 */
export class NotAnObsidianVaultError extends Error {
  constructor(vaultPath: string) {
    super(
      `"${vaultPath}" はObsidian vaultとして認識できませんでした（.obsidianディレクトリが見つかりません）。` +
        `正しいvaultのパスを指定してください。`,
    );
    this.name = 'NotAnObsidianVaultError';
  }
}

export class VaultNotAllowedError extends Error {
  constructor(vaultPath: string) {
    super(`"${vaultPath}" は許可されたvaultパスに含まれていません。O2N_ALLOWED_VAULTS に明示してください。`);
    this.name = 'VaultNotAllowedError';
  }
}

export interface VaultGuardOptions {
  allowedVaultRoots?: string[];
}

async function canonicalPath(p: string): Promise<string> {
  return fs.realpath(path.resolve(p));
}

export async function assertObsidianVault(vaultPath: string, opts: VaultGuardOptions = {}): Promise<string> {
  let resolved: string;
  try {
    resolved = await canonicalPath(vaultPath);
  } catch {
    throw new NotAnObsidianVaultError(path.resolve(vaultPath));
  }
  try {
    const obsidianPath = path.join(resolved, '.obsidian');
    const linkStat = await fs.lstat(obsidianPath);
    if (linkStat.isSymbolicLink()) throw new Error('symlink');
    const stat = await fs.stat(obsidianPath);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new NotAnObsidianVaultError(resolved);
  }

  if (opts.allowedVaultRoots) {
    const allowed = await Promise.all(opts.allowedVaultRoots.map((p) => canonicalPath(p)));
    if (!allowed.includes(resolved)) {
      throw new VaultNotAllowedError(resolved);
    }
  }
  return resolved;
}
