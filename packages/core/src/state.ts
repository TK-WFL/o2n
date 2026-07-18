import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileState, FolderState, NoteState, StateFile } from './types.js';

export function contentHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function stateDir(vaultPath: string): string {
  return path.join(vaultPath, '.o2n');
}

export function statePath(vaultPath: string): string {
  return path.join(stateDir(vaultPath), 'state.json');
}

/**
 * .o2n/state.json の読み書きを担うストア。
 * F5: 「API成功のたびに書き込む（クラッシュ耐性）」を満たすため、
 * 更新のたびに即ディスクへ書き込む（tmpファイル→renameでアトミックに）。
 * 書き込みはPromiseチェーンで直列化し、並行呼び出しでも壊れないようにする。
 */
export class StateStore {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly vaultPath: string,
    private readonly data: StateFile,
  ) {}

  static async load(vaultPath: string, parentPageId: string): Promise<StateStore> {
    const p = statePath(vaultPath);
    try {
      const raw = await fs.readFile(p, 'utf-8');
      const data = JSON.parse(raw) as StateFile;
      data.folders = data.folders ?? {};
      return new StateStore(vaultPath, data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const fresh: StateFile = { version: 1, parentPageId, notes: {}, files: {}, folders: {} };
      return new StateStore(vaultPath, fresh);
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

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.writeNow());
    return this.writeChain;
  }

  private async writeNow(): Promise<void> {
    const dir = stateDir(this.vaultPath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = statePath(this.vaultPath) + `.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    await fs.rename(tmp, statePath(this.vaultPath));
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
