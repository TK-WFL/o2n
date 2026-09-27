import { NotionApi, NotionClient, rateLimitFromEnv, saveCredentials } from '@tk_wfl/o2n-core';
import { describeError } from '../errors.js';
import { promptHidden } from '../prompt.js';

/**
 * `o2n login --token`：個人アクセストークン（PAT）や internal integration のトークンを
 * `~/.o2n/credentials.json` に保存する（#164）。
 *
 * トークンはコマンドライン引数では受け取らない（シェルの履歴やプロセス一覧に残るため）。
 * 端末から実行したときは入力を伏せたプロンプトで、パイプで渡されたときは標準入力の1行目を読む。
 * 保存前に `GET /users/me` で有効性を確かめ、無効なトークンは保存しない。
 *
 * 保存したトークンは CLI と MCP サーバーの両方が使う。Claude のプラグインを Cowork で使う場合、
 * Cowork はトークン入力画面を出さないので、この経路で保存しておく。
 */
export interface TokenLoginDeps {
  /** トークン文字列を得る（既定: TTY なら伏せ字プロンプト、そうでなければ標準入力） */
  readToken: () => Promise<string>;
  /** トークンが使えるか確かめ、ワークスペース名（分かれば）を返す */
  verify: (token: string) => Promise<{ workspaceName: string | null }>;
  save: typeof saveCredentials;
  now: () => Date;
}

const MAX_TOKEN_LENGTH = 512;

function sanitizeConsoleText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

async function readStdinFirstLine(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buf);
    total += buf.length;
    if (total > 64 * 1024) break;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
}

async function defaultReadToken(): Promise<string> {
  if (process.stdin.isTTY) {
    return promptHidden('Notion のトークンを貼り付けて Enter を押してください（入力は表示されません）: ');
  }
  return readStdinFirstLine();
}

async function defaultVerify(token: string): Promise<{ workspaceName: string | null }> {
  const api = new NotionApi(new NotionClient({ token, dryRun: false, rateLimit: rateLimitFromEnv() }));
  const me = await api.getMe();
  return { workspaceName: me.bot?.workspace_name ?? null };
}

export async function loginWithTokenCommand(deps: Partial<TokenLoginDeps> = {}): Promise<number> {
  const readToken = deps.readToken ?? defaultReadToken;
  const verify = deps.verify ?? defaultVerify;
  const save = deps.save ?? saveCredentials;
  const now = deps.now ?? (() => new Date());

  let token: string;
  try {
    token = (await readToken()).trim();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (!token) {
    console.error('トークンが入力されませんでした。');
    return 2;
  }
  if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    console.error('トークンの形式が正しくありません（空白を含むか、長すぎます）。コピーし直してください。');
    return 2;
  }

  let workspaceName: string | null;
  try {
    ({ workspaceName } = await verify(token));
  } catch (err) {
    console.error(`トークンを確認できなかったため保存しませんでした。\n${describeError(err)}`);
    return 2;
  }

  const safeName = sanitizeConsoleText(workspaceName);
  await save({ token, workspaceName: safeName, savedAt: now().toISOString() });
  console.log(`トークンを保存しました${safeName ? `（ワークスペース: ${safeName}）` : ''}。`);
  console.log('以降、NOTION_TOKEN を設定しなくても o2n の CLI と MCP サーバーがこのトークンを使います。解除は `o2n logout`。');
  return 0;
}
