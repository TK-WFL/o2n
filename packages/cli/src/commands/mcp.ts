import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  assertObsidianVault,
  emptyMcpSettings,
  loadMcpSettings,
  MIN_WRITE_TOKEN_LENGTH,
  NotAnObsidianVaultError,
  resolveMcpAccess,
  saveMcpSettings,
  type McpSettings,
} from '@tk_wfl/o2n-core';
import { isInteractiveTerminal, promptHidden } from '../prompt.js';

/**
 * `o2n mcp ...`：MCP サーバーの許可 vault・書き込み許可・確認フレーズを `~/.o2n/mcp-settings.json` に保存する（#170）。
 * Claude のプラグインを Cowork で使うと設定画面が出ないため、ここで保存した値を MCP サーバーが使う。
 *
 * 設定を広げる操作（allow / write on）は対話端末からだけ受け付ける。Claude などがツール経由で
 * コマンドを実行して、自分に vault の読み取りや Notion への書き込みを許可することを防ぐため。
 */
export interface McpCommandDeps {
  isInteractive: () => boolean;
  prompt: (question: string) => Promise<string>;
  load: () => Promise<McpSettings | null>;
  save: (settings: McpSettings) => Promise<void>;
  now: () => Date;
  env: NodeJS.ProcessEnv;
}

function withDefaults(deps: Partial<McpCommandDeps>): McpCommandDeps {
  return {
    isInteractive: deps.isInteractive ?? isInteractiveTerminal,
    prompt: deps.prompt ?? promptHidden,
    load: deps.load ?? loadMcpSettings,
    save: deps.save ?? saveMcpSettings,
    now: deps.now ?? (() => new Date()),
    env: deps.env ?? process.env,
  };
}

const NEEDS_TERMINAL =
  'この設定はターミナルで直接実行したときだけ変更できます（Claude などのツール経由では変更できません）。ターミナルを開いて同じコマンドを実行してください。';

async function current(d: McpCommandDeps): Promise<McpSettings> {
  return (await d.load()) ?? emptyMcpSettings();
}

async function persist(d: McpCommandDeps, settings: McpSettings): Promise<void> {
  await d.save({ ...settings, updatedAt: d.now().toISOString() });
}

function envOverrideNote(d: McpCommandDeps): string[] {
  const notes: string[] = [];
  if ((d.env.O2N_ALLOWED_VAULTS ?? '').trim()) {
    notes.push('注意: このシェルでは環境変数 O2N_ALLOWED_VAULTS が設定されています。MCP サーバーの環境にも設定されている場合は、そちらが優先されます。');
  }
  return notes;
}

export async function mcpAllowCommand(vaultPath: string, deps: Partial<McpCommandDeps> = {}): Promise<number> {
  const d = withDefaults(deps);
  if (!d.isInteractive()) {
    console.error(NEEDS_TERMINAL);
    return 2;
  }
  let resolved: string;
  try {
    resolved = await assertObsidianVault(vaultPath);
  } catch (err) {
    if (err instanceof NotAnObsidianVaultError) {
      console.error(`${err.message}\nObsidian の vault（.obsidian フォルダがあるフォルダ）を指定してください。`);
      return 2;
    }
    throw err;
  }
  const settings = await current(d);
  if (settings.allowedVaults.includes(resolved)) {
    console.log(`既に許可されています: ${resolved}`);
    return 0;
  }
  settings.allowedVaults = [...settings.allowedVaults, resolved];
  await persist(d, settings);
  console.log(`MCP サーバーからの読み取りを許可しました: ${resolved}`);
  for (const n of envOverrideNote(d)) console.log(n);
  return 0;
}

export async function mcpDisallowCommand(vaultPath: string, deps: Partial<McpCommandDeps> = {}): Promise<number> {
  const d = withDefaults(deps);
  const settings = await current(d);
  // vault が既に消えていても外せるよう、入力そのもの・絶対パス・実パスのどれかが一致すれば外す
  const candidates = new Set([vaultPath, path.resolve(vaultPath)]);
  try {
    candidates.add(await fs.realpath(path.resolve(vaultPath)));
  } catch {
    // 存在しないパスは実パスを求めない
  }
  const remaining = settings.allowedVaults.filter((p) => !candidates.has(p));
  if (remaining.length === settings.allowedVaults.length) {
    console.log(`許可リストにありません: ${vaultPath}`);
    return 1;
  }
  await persist(d, { ...settings, allowedVaults: remaining });
  console.log(`許可を取り消しました: ${vaultPath}`);
  return 0;
}

export async function mcpWriteCommand(mode: string, deps: Partial<McpCommandDeps> = {}): Promise<number> {
  const d = withDefaults(deps);
  if (mode === 'off') {
    const settings = await current(d);
    const { writeConfirmationToken: _removed, ...rest } = settings;
    await persist(d, { ...rest, writeEnabled: false });
    console.log('MCP サーバーからの Notion への書き込みを無効にし、確認フレーズを削除しました。');
    return 0;
  }
  if (mode !== 'on') {
    console.error('`o2n mcp write on` か `o2n mcp write off` を指定してください。');
    return 2;
  }
  if (!d.isInteractive()) {
    console.error(NEEDS_TERMINAL);
    return 2;
  }
  let phrase: string;
  try {
    phrase = await d.prompt(
      `確認フレーズを入力してください（${MIN_WRITE_TOKEN_LENGTH} 文字以上、入力は表示されません。空のまま Enter で自動生成）: `,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  let generated = false;
  if (phrase === '') {
    phrase = crypto.randomBytes(18).toString('base64url');
    generated = true;
  }
  if (phrase.length < MIN_WRITE_TOKEN_LENGTH || phrase.length > 256) {
    console.error(`確認フレーズは ${MIN_WRITE_TOKEN_LENGTH}〜256 文字にしてください。`);
    return 2;
  }
  const settings = await current(d);
  await persist(d, { ...settings, writeEnabled: true, writeConfirmationToken: phrase });
  console.log('MCP サーバーからの Notion への書き込みを有効にしました。');
  if (generated) {
    console.log(`確認フレーズ: ${phrase}`);
    console.log('このフレーズは再表示できません。本実行したいときだけ、Claude に伝えてください。');
  } else {
    console.log('本実行したいときだけ、入力した確認フレーズを Claude に伝えてください。');
  }
  return 0;
}

export async function mcpStatusCommand(deps: Partial<McpCommandDeps> = {}): Promise<number> {
  const d = withDefaults(deps);
  const file = await d.load();
  const effective = await resolveMcpAccess(d.env, async () => file);
  console.log('保存された設定（~/.o2n/mcp-settings.json）');
  if (!file) {
    console.log('  まだありません。');
  } else {
    console.log(`  許可する vault: ${file.allowedVaults.length === 0 ? 'なし' : ''}`);
    for (const v of file.allowedVaults) console.log(`    - ${v}`);
    console.log(`  Notion への書き込み: ${file.writeEnabled ? '有効' : '無効'}`);
    console.log(`  確認フレーズ: ${file.writeConfirmationToken ? '設定済み' : '未設定'}`);
  }
  const src = (s: string | null) => (s === 'env' ? '環境変数' : s === 'file' ? '保存された設定' : 'なし');
  console.log('このシェルの環境で MCP サーバーを起動した場合に使われる設定');
  console.log(`  許可する vault: ${src(effective.allowedVaultsSource)}`);
  console.log(`  書き込み許可: ${effective.writeEnabled ? `有効（${src(effective.writeEnabledSource)}）` : '無効'}`);
  console.log(`  確認フレーズ: ${src(effective.writeTokenSource)}`);
  return 0;
}
