import { z } from 'zod';
import { atomicWriteHomeStateFile, readHomeStateFile } from './local-state-io.js';

/**
 * MCP サーバーの許可 vault・書き込み許可・確認フレーズを `~/.o2n/mcp-settings.json` に保存する（#170）。
 *
 * Claude のプラグインを Cowork で使うと、Cowork は設定画面を出さないため環境変数が既定値（空・false）の
 * ままになる。その場合でも、ユーザーが端末で `o2n mcp ...` を実行して保存したこのファイルから設定を読む。
 * ファイルは credentials.json と同じ保護（0600、symlink・hardlink 拒否など）で読み書きする。
 */
export const MIN_WRITE_TOKEN_LENGTH = 16;
const MAX_WRITE_TOKEN_LENGTH = 256;

const mcpSettingsSchema = z
  .object({
    version: z.literal(1),
    allowedVaults: z.array(z.string().min(1).max(4096)).max(100),
    writeEnabled: z.boolean(),
    writeConfirmationToken: z.string().min(MIN_WRITE_TOKEN_LENGTH).max(MAX_WRITE_TOKEN_LENGTH).optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type McpSettings = z.infer<typeof mcpSettingsSchema>;

export class McpSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSettingsError';
  }
}

export function emptyMcpSettings(): McpSettings {
  return { version: 1, allowedVaults: [], writeEnabled: false };
}

export async function loadMcpSettings(): Promise<McpSettings | null> {
  let raw: string;
  try {
    raw = await readHomeStateFile('mcp-settings.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpSettingsError('~/.o2n/mcp-settings.json が JSON として読めません。`o2n mcp status` で確認し、必要なら削除して設定し直してください。');
  }
  const result = mcpSettingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new McpSettingsError('~/.o2n/mcp-settings.json の内容が正しくありません。`o2n mcp` コマンドで設定し直してください。');
  }
  return result.data;
}

export async function saveMcpSettings(settings: McpSettings): Promise<void> {
  const validated = mcpSettingsSchema.parse(settings);
  await atomicWriteHomeStateFile('mcp-settings.json', JSON.stringify(validated, null, 2));
}

/**
 * on/off の環境変数を読む。`1` と `true`（大文字小文字・前後の空白は問わない）だけを有効とみなす。
 * Claude のプラグイン設定の boolean は `"true"` / `"false"` として渡る（#165）
 */
export function isTruthyFlag(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

export type McpSettingSource = 'env' | 'file';

export interface McpAccess {
  /** 許可する vault のパス（未設定なら null = すべて拒否） */
  allowedVaults: string[] | null;
  allowedVaultsSource: McpSettingSource | null;
  writeEnabled: boolean;
  writeEnabledSource: McpSettingSource | null;
  /** 確認フレーズ（16 文字未満や未設定なら null = 本実行は常に拒否） */
  writeToken: string | null;
  writeTokenSource: McpSettingSource | null;
}

function splitVaultList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * MCP サーバーが従う設定を決める。どの項目も「環境変数に値があれば環境変数、なければ保存ファイル」。
 * - 許可 vault: `O2N_ALLOWED_VAULTS` が空でなければそれだけを使う（ファイルとは合算しない）
 * - 書き込み許可: `O2N_ENABLE_MCP_WRITE` が `1`/`true` なら有効。空・`false` は「未指定」とみなしファイルに従う
 *   （プラグインは未設定でも `false` を渡すため。ファイルは端末から `o2n mcp write on` でしか書かれない）
 * - 確認フレーズ: `O2N_MCP_WRITE_TOKEN` が空でなければそれ、なければファイル。16 文字未満は無効
 */
export async function resolveMcpAccess(
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<McpSettings | null> = loadMcpSettings,
): Promise<McpAccess> {
  let file: McpSettings | null | undefined;
  const fileSettings = async () => {
    if (file === undefined) file = await load();
    return file;
  };

  let allowedVaults: string[] | null = null;
  let allowedVaultsSource: McpSettingSource | null = null;
  const envVaults = splitVaultList(env.O2N_ALLOWED_VAULTS);
  if (envVaults.length > 0) {
    allowedVaults = envVaults;
    allowedVaultsSource = 'env';
  } else {
    const fromFile = (await fileSettings())?.allowedVaults ?? [];
    if (fromFile.length > 0) {
      allowedVaults = fromFile;
      allowedVaultsSource = 'file';
    }
  }

  let writeEnabled = false;
  let writeEnabledSource: McpSettingSource | null = null;
  if (isTruthyFlag(env.O2N_ENABLE_MCP_WRITE)) {
    writeEnabled = true;
    writeEnabledSource = 'env';
  } else if ((await fileSettings())?.writeEnabled) {
    writeEnabled = true;
    writeEnabledSource = 'file';
  }

  let writeToken: string | null = null;
  let writeTokenSource: McpSettingSource | null = null;
  const envToken = env.O2N_MCP_WRITE_TOKEN;
  if (envToken !== undefined && envToken !== '') {
    if (envToken.length >= MIN_WRITE_TOKEN_LENGTH) {
      writeToken = envToken;
      writeTokenSource = 'env';
    }
  } else {
    const fromFile = (await fileSettings())?.writeConfirmationToken;
    if (fromFile && fromFile.length >= MIN_WRITE_TOKEN_LENGTH) {
      writeToken = fromFile;
      writeTokenSource = 'file';
    }
  }

  return { allowedVaults, allowedVaultsSource, writeEnabled, writeEnabledSource, writeToken, writeTokenSource };
}
