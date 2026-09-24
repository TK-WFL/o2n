import { createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileState, FolderState, NoteState, StateFile } from './types.js';
import { parseStateFile } from './schemas.js';
import {
  atomicWriteHomeStateFile,
  atomicWriteVaultStateFile,
  readHomeStateFile,
  readVaultStateFile,
} from './local-state-io.js';

export function contentHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function planHash(plan: unknown): string {
  return 'sha256:' + createHash('sha256').update(stableStringify(plan), 'utf-8').digest('hex');
}

export function stateDir(vaultPath: string): string {
  return path.join(vaultPath, '.o2n');
}

export function statePath(vaultPath: string): string {
  return path.join(stateDir(vaultPath), 'state.json');
}

async function loadOrCreateSigningKey(readOnly: boolean): Promise<string | null> {
  try {
    return await readHomeStateFile('state-signing-key');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (readOnly) return null;
    const key = randomBytes(32).toString('hex');
    await atomicWriteHomeStateFile('state-signing-key', key);
    return key;
  }
}

function unsignedStateData(data: StateFile): StateFile {
  const { signature, ...unsigned } = data;
  void signature;
  return unsigned;
}

function signState(data: StateFile, key: string): string {
  return 'hmac-sha256:' + createHmac('sha256', key).update(JSON.stringify(unsignedStateData(data))).digest('hex');
}

export class StateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateIntegrityError';
  }
}

export interface StateLoadOptions {
  readOnly?: boolean;
  planHash?: string;
  notionWorkspaceId?: string;
  notionBotId?: string;
  allowUnsignedState?: boolean;
}

/**
 * .o2n/state.json の読み書きを担うストア。
 * F5: 「API成功のたびに書き込む（クラッシュ耐性）」を満たすため、
 * 更新のたびに即ディスクへ書き込む（tmpファイル→renameでアトミックに）。
 * 書き込みはPromiseチェーンで直列化し、並行呼び出しでも壊れないようにする。
 */
export class StateStore {
  private writeChain: Promise<void> = Promise.resolve();
  private signingKey: string | null = null;

  private constructor(
    private readonly vaultPath: string,
    private readonly data: StateFile,
    /**
     * dry-run用: trueの場合、実在のstate.jsonは読み込む（正確な進捗表示のため）が、
     * 一切ディスクに書き込まない。dry-runの結果が本実行の「作成済み」判定を
     * 汚染してしまう不具合を防ぐため。
     */
    private readonly readOnly: boolean,
  ) {}

  static async load(vaultPath: string, parentPageId: string, opts: StateLoadOptions = {}): Promise<StateStore> {
    const readOnly = opts.readOnly ?? false;
    const canonicalVaultPath = await fs.realpath(vaultPath);
    const signingKey = await loadOrCreateSigningKey(readOnly);
    try {
      const raw = await readVaultStateFile(vaultPath, 'state.json');
      const data = parseStateFile(JSON.parse(raw));
      validateStateBinding(data, {
        parentPageId,
        canonicalVaultPath,
        planHash: opts.planHash,
        notionWorkspaceId: opts.notionWorkspaceId,
        notionBotId: opts.notionBotId,
        signingKey,
        allowUnsignedState: opts.allowUnsignedState ?? true,
      });
      if (data.version !== 2 && !readOnly) {
        data.version = 2;
        data.canonicalVaultPath = canonicalVaultPath;
        data.planHash = opts.planHash;
        data.notionWorkspaceId = opts.notionWorkspaceId;
        data.notionBotId = opts.notionBotId;
      }
      const store = new StateStore(vaultPath, data, readOnly);
      store.signingKey = signingKey;
      return store;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const fresh: StateFile = {
        version: 2,
        parentPageId,
        canonicalVaultPath,
        planHash: opts.planHash,
        notionWorkspaceId: opts.notionWorkspaceId,
        notionBotId: opts.notionBotId,
        notes: {},
        files: {},
        folders: {},
      };
      const store = new StateStore(vaultPath, fresh, readOnly);
      store.signingKey = signingKey;
      if (!readOnly && signingKey) {
        fresh.signature = signState(fresh, signingKey);
      }
      return store;
    }
  }

  get snapshot(): StateFile {
    return this.data;
  }

  getNote(notePath: string): NoteState | undefined {
    return this.data.notes[notePath];
  }

  setNote(notePath: string, state: NoteState): Promise<void> {
    this.data.notes[notePath] = state;
    return this.persist();
  }

  getFile(filePath: string): FileState | undefined {
    return this.data.files[filePath];
  }

  setFile(filePath: string, state: FileState): Promise<void> {
    this.data.files[filePath] = state;
    return this.persist();
  }

  getFolder(folderPath: string): FolderState | undefined {
    return this.data.folders[folderPath];
  }

  setFolder(folderPath: string, state: FolderState): Promise<void> {
    this.data.folders[folderPath] = state;
    return this.persist();
  }

  private dirty = false;

  /**
   * 書き込みをまとめる（#111）: 以前は setNote/setFile のたびに state.json 全体を署名・書き直して
   * いたため、1万ノート規模では O(n²) の CPU/ディスク負荷が支配的だった。現在は「書き込み中に
   * 来た更新はまとめて次の1回で書く」ため、ディスク書き込み回数は API 呼び出し回数ではなく
   * 書き込み1回の所要時間で決まる。最後に flush() で確実に書き切る（runMigration が呼ぶ）。
   */
  private persist(): Promise<void> {
    if (this.readOnly) return Promise.resolve();
    this.dirty = true;
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await this.writeNow();
    });
    return this.writeChain;
  }

  /** 保留中の書き込みを全て完了させる */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async writeNow(): Promise<void> {
    if (this.signingKey) {
      this.data.signature = signState(this.data, this.signingKey);
    }
    await atomicWriteVaultStateFile(
      this.vaultPath,
      'state.json',
      JSON.stringify(this.data, null, 2),
    );
  }
}

function validateStateBinding(
  data: StateFile,
  opts: {
    parentPageId: string;
    canonicalVaultPath: string;
    planHash?: string;
    notionWorkspaceId?: string;
    notionBotId?: string;
    signingKey: string | null;
    allowUnsignedState: boolean;
  },
): void {
  if (data.parentPageId !== opts.parentPageId) {
    throw new StateIntegrityError('state.json の parentPageId が現在の計画と一致しません。別の移行先へやり直す場合は vault 内の .o2n/state.json を削除してから migrate を実行してください（Notion 上の既存ページは削除されません）。');
  }

  if (data.version !== 2) {
    if (!opts.allowUnsignedState) {
      throw new StateIntegrityError('署名されていない旧state.jsonはこの実行経路では使用できません。CLIで明示的に移行または破棄してください。');
    }
    return;
  }

  if (data.canonicalVaultPath !== opts.canonicalVaultPath) {
    throw new StateIntegrityError('state.json のvaultパスが現在のvaultと一致しません。');
  }
  if (opts.planHash && data.planHash !== opts.planHash) {
    throw new StateIntegrityError('state.json のplanHashが現在の計画と一致しません。');
  }
  if (opts.notionWorkspaceId && data.notionWorkspaceId !== opts.notionWorkspaceId) {
    throw new StateIntegrityError('state.json のNotion workspaceが現在の認証情報と一致しません。');
  }
  if (opts.notionBotId && data.notionBotId !== opts.notionBotId) {
    throw new StateIntegrityError('state.json のNotion botが現在の認証情報と一致しません。');
  }
  if (!opts.signingKey || !data.signature || data.signature !== signState(data, opts.signingKey)) {
    throw new StateIntegrityError('state.json の署名検証に失敗しました。改ざんの可能性があるため停止します。');
  }
}

/**
 * resume用の冪等性判定: 既にcreated以降で、本文ハッシュが一致すれば再作成不要
 */
export function isNoteUpToDate(state: NoteState | undefined, currentHash: string): boolean {
  if (!state) return false;
  if (state.status === 'pending' || state.status === 'failed') return false;
  return state.contentHash === currentHash;
}
