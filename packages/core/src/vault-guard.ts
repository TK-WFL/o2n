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

export async function assertObsidianVault(vaultPath: string): Promise<void> {
  const resolved = path.resolve(vaultPath);
  try {
    const stat = await fs.stat(path.join(resolved, '.obsidian'));
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new NotAnObsidianVaultError(resolved);
  }
}
