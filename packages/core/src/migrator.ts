import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildNameIndex, resolveByFilename } from './scanner.js';
import { convertNote, ESCAPE_SENTINEL, ESCAPE_TARGET, type ConverterContext } from './converter.js';
import type { NotionApi, UpdateContentItem } from './notion-client.js';
import type { StateStore } from './state.js';
import { contentHash, isNoteUpToDate } from './state.js';
import { createDatabaseForFolder, buildRowProperties } from './notion-db.js';
import {
  buildTitleProperty,
  buildFrontmatterMetaCallout,
  splitMarkdownForPayload,
  shouldUseAsyncWrite,
  buildAttachmentBlock,
} from './notion-blocks.js';
import type { MigrationPlan, NoteRecord, ReportEntry, VaultInventory } from './types.js';

export interface MigratorOptions {
  vaultPath: string;
  plan: MigrationPlan;
  inventory: VaultInventory;
  api: NotionApi;
  state: StateStore;
  dryRun: boolean;
  /** ノート単位の進捗コールバック（総ノート数ベースの進捗表示用） */
  onProgress?: (done: number, total: number, notePath: string) => void;
}

interface Container {
  kind: 'page' | 'database';
  id: string;
  dataSourceId?: string;
}

function folderOf(notePath: string): string {
  const dir = path.posix.dirname(notePath);
  return dir === '.' ? '' : dir;
}

function basenameNoExt(p: string): string {
  return path.posix.basename(p).replace(/\.md$/, '');
}

function folderDepth(folderPath: string): number {
  return folderPath === '' ? 0 : folderPath.split('/').length;
}

function buildResolvers(inventory: VaultInventory, sourcePath: string): ConverterContext {
  const noteIndex = buildNameIndex(inventory.notes.map((n) => n.path));
  const fileIndex = buildNameIndex(
    // 添付は vault 内の非.mdファイル全体から解決（wikiLinks抽出時と同じロジック）
    inventory.attachments
      .map((a) => a.targetPath)
      .filter((p): p is string => p !== null),
  );
  return {
    sourcePath,
    resolveNoteLink: (target: string) => resolveByFilename(target, sourcePath, noteIndex).resolved,
    resolveAttachment: (target: string) => resolveByFilename(target, sourcePath, fileIndex).resolved,
  };
}

/**
 * フォルダ=親ページ(page_tree) or DB(database) のコンテナを、親→子の順で作成する。
 */
async function createFolderContainers(
  opts: MigratorOptions,
  report: ReportEntry[],
): Promise<Map<string, Container>> {
  const { plan, state, api, dryRun } = opts;
  const containers = new Map<string, Container>();
  containers.set('', { kind: 'page', id: plan.parentPageId });

  const folders = [...plan.folders].filter((f) => f.folderPath !== '').sort((a, b) => folderDepth(a.folderPath) - folderDepth(b.folderPath));

  for (const folder of folders) {
    const existing = state.getFolder(folder.folderPath);
    if (existing?.status === 'created') {
      containers.set(folder.folderPath, {
        kind: existing.kind,
        id: existing.notionId,
        dataSourceId: existing.dataSourceId,
      });
      continue;
    }

    const parentFolderPath = folderOf(folder.folderPath);
    let parentContainer = containers.get(parentFolderPath);
    if (!parentContainer) {
      parentContainer = { kind: 'page', id: plan.parentPageId };
    }
    if (parentContainer.kind === 'database') {
      report.push({
        category: 'warning',
        path: folder.folderPath,
        message: `親フォルダ "${parentFolderPath}" がdatabaseモードのため、サブフォルダはルート直下に作成しました`,
      });
      parentContainer = { kind: 'page', id: plan.parentPageId };
    }

    const title = path.posix.basename(folder.folderPath);

    try {
      if (folder.mode === 'database') {
        if (dryRun) {
          const c: Container = { kind: 'database', id: `dry-run-db-${folder.folderPath}`, dataSourceId: `dry-run-ds-${folder.folderPath}` };
          containers.set(folder.folderPath, c);
          api.callCount; // dry-runでもカウンタは進む（呼び出しはされない）
          await createDatabaseForFolder(api, parentContainer.id, title, plan.frontmatterMappings[folder.folderPath] ?? []);
          await state.setFolder(folder.folderPath, { status: 'created', kind: 'database', notionId: c.id, dataSourceId: c.dataSourceId });
          continue;
        }
        const { databaseId, dataSourceId } = await createDatabaseForFolder(
          api,
          parentContainer.id,
          title,
          plan.frontmatterMappings[folder.folderPath] ?? [],
        );
        containers.set(folder.folderPath, { kind: 'database', id: databaseId, dataSourceId });
        await state.setFolder(folder.folderPath, { status: 'created', kind: 'database', notionId: databaseId, dataSourceId });
      } else {
        if (dryRun) {
          const id = `dry-run-page-${folder.folderPath}`;
          containers.set(folder.folderPath, { kind: 'page', id });
          await api.createPageMarkdown({ parent: { page_id: parentContainer.id }, properties: { title: buildTitleProperty(title) } });
          await state.setFolder(folder.folderPath, { status: 'created', kind: 'page', notionId: id });
          continue;
        }
        const page = await api.createPageMarkdown({
          parent: { page_id: parentContainer.id },
          properties: { title: buildTitleProperty(title) },
        });
        containers.set(folder.folderPath, { kind: 'page', id: page.id });
        await state.setFolder(folder.folderPath, { status: 'created', kind: 'page', notionId: page.id });
      }
    } catch (err) {
      await state.setFolder(folder.folderPath, {
        status: 'failed',
        kind: folder.mode === 'database' ? 'database' : 'page',
        notionId: '',
        error: String(err),
      });
      report.push({ category: 'warning', path: folder.folderPath, message: `フォルダコンテナ作成に失敗: ${String(err)}` });
    }
  }

  return containers;
}

async function runPass1(
  opts: MigratorOptions,
  containers: Map<string, Container>,
  report: ReportEntry[],
): Promise<void> {
  const { plan, inventory, state, api, dryRun, vaultPath, onProgress } = opts;
  const skipSet = new Set(plan.skipList);
  const total = inventory.notes.length;
  let done = 0;

  for (const note of inventory.notes) {
    if (skipSet.has(note.path)) {
      await state.setNote(note.path, { status: 'skipped' });
      done += 1;
      onProgress?.(done, total, note.path);
      continue;
    }
    const hash = contentHash(note.content);
    const existing = state.getNote(note.path);
    if (isNoteUpToDate(existing, hash) && existing) {
      done += 1;
      onProgress?.(done, total, note.path);
      continue;
    }

    const folder = folderOf(note.path);
    const container = containers.get(folder) ?? { kind: 'page' as const, id: plan.parentPageId };

    const ctx = buildResolvers(inventory, note.path);
    const converted = convertNote(note.content, ctx);
    report.push(...converted.entries);

    const title = (note.frontmatter.title as string | undefined) || basenameNoExt(note.path);

    let markdown: string;
    let properties: Record<string, unknown>;
    let parent: { page_id: string } | { type: 'data_source_id'; data_source_id: string };

    if (container.kind === 'database' && container.dataSourceId) {
      markdown = converted.markdown;
      properties = buildRowProperties(note.frontmatter, plan.frontmatterMappings[folder] ?? [], title);
      parent = { type: 'data_source_id', data_source_id: container.dataSourceId };
    } else {
      markdown = buildFrontmatterMetaCallout(note.frontmatter) + converted.markdown;
      properties = { title: buildTitleProperty(title) };
      parent = { page_id: container.id };
    }

    const chunks = splitMarkdownForPayload(markdown);

    try {
      if (dryRun) {
        await api.createPageMarkdown({ parent, markdown: chunks[0], properties });
        for (const chunk of chunks.slice(1)) {
          await api.updatePageMarkdown('dry-run', {
            type: 'insert_content',
            insert_content: { content: chunk, position: { type: 'end' } },
          });
        }
        await state.setNote(note.path, {
          status: 'created',
          pageId: `dry-run-${note.path}`,
          pageUrl: `https://www.notion.so/dry-run-${encodeURIComponent(note.path)}`,
          contentHash: hash,
        });
        done += 1;
        onProgress?.(done, total, note.path);
        continue;
      }

      const page = await api.createPageMarkdown({ parent, markdown: chunks[0], properties });
      for (const chunk of chunks.slice(1)) {
        await api.updatePageMarkdown(
          page.id,
          { type: 'insert_content', insert_content: { content: chunk, position: { type: 'end' } } },
          shouldUseAsyncWrite(chunk),
        );
      }
      await state.setNote(note.path, { status: 'created', pageId: page.id, pageUrl: page.url, contentHash: hash });
    } catch (err) {
      await state.setNote(note.path, { status: 'failed', contentHash: hash, error: String(err) });
      report.push({ category: 'warning', path: note.path, message: `ページ作成に失敗: ${String(err)}` });
    }
    done += 1;
    onProgress?.(done, total, note.path);
  }
  void vaultPath;
}

async function runPass2(opts: MigratorOptions, report: ReportEntry[]): Promise<void> {
  const { inventory, state, api, dryRun } = opts;

  for (const note of inventory.notes) {
    const noteState = state.getNote(note.path);
    if (!noteState || noteState.status !== 'created' || !noteState.pageId) continue;

    const ctx = buildResolvers(inventory, note.path);
    const reconverted = convertNote(note.content, ctx);

    const updates: UpdateContentItem[] = [];
    for (const link of reconverted.pendingLinks) {
      const targetState = link.targetPath ? state.getNote(link.targetPath) : undefined;
      let newStr: string;
      if (targetState?.pageUrl && (targetState.status === 'created' || targetState.status === 'linked' || targetState.status === 'attached' || targetState.status === 'done')) {
        newStr = `[${link.displayText}](${targetState.pageUrl})`;
      } else {
        newStr = link.fallbackText;
        report.push({ category: 'unresolved_link', path: note.path, message: `リンク "${link.fallbackText}" は解決できず元表記に戻しました` });
      }
      updates.push({ old_str: link.placeholder, new_str: newStr, replace_all_matches: true });
    }
    if (reconverted.needsEscapeRestore) {
      updates.push({ old_str: ESCAPE_SENTINEL, new_str: ESCAPE_TARGET, replace_all_matches: true });
    }

    try {
      if (updates.length > 0) {
        await api.updatePageMarkdown(noteState.pageId, { type: 'update_content', update_content: { content_updates: updates } });
      }
      await state.setNote(note.path, { ...noteState, status: 'linked' });
    } catch (err) {
      // ページ自体は作成済みのため status は 'created' のまま保つ（'failed' にすると
      // resumeでPass1が再度ページを作成してしまい重複が発生する）。次回resume時に
      // Pass2が改めてこのノートを処理する。
      await state.setNote(note.path, { ...noteState, status: 'created', error: String(err) });
      report.push({ category: 'warning', path: note.path, message: `リンク解決に失敗: ${String(err)}` });
    }
    void dryRun;
  }
}

const SINGLE_PART_LIMIT = 20 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

function mimeTypeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * §16検証済み（2026-07-19）: createFileUpload時にcontent_typeを指定しないと、
 * send時にNotionが「作成時に決定された元のcontent typeと一致しない」として400を返す。
 * 作成時とBlobのtypeの両方で同じMIMEタイプを明示する必要がある。
 */
async function uploadFile(api: NotionApi, absPath: string, size: number, dryRun: boolean): Promise<string> {
  const filename = path.basename(absPath);
  if (dryRun) return `dry-run-upload-${filename}`;
  const contentType = mimeTypeFor(filename);

  if (size <= SINGLE_PART_LIMIT) {
    const created = await api.createFileUpload({ filename, content_type: contentType, mode: 'single_part' });
    const buf = await fs.readFile(absPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: contentType }), filename);
    await api.sendFileUpload(created.id, form);
    return created.id;
  }

  // マルチパート: §4.1 マルチパートアップロード。実ワークスペースでの完了フローは docs/questions.md 参照
  const numberOfParts = Math.ceil(size / SINGLE_PART_LIMIT);
  const created = await api.createFileUpload({ filename, content_type: contentType, mode: 'multi_part', number_of_parts: numberOfParts });
  const fh = await fs.open(absPath, 'r');
  try {
    for (let i = 0; i < numberOfParts; i += 1) {
      const partSize = Math.min(SINGLE_PART_LIMIT, size - i * SINGLE_PART_LIMIT);
      const buf = Buffer.alloc(partSize);
      await fh.read(buf, 0, partSize, i * SINGLE_PART_LIMIT);
      const form = new FormData();
      form.append('file', new Blob([buf], { type: contentType }), filename);
      form.append('part_number', String(i + 1));
      await api.sendFileUpload(created.id, form);
    }
  } finally {
    await fh.close();
  }
  return created.id;
}

async function runPass3(opts: MigratorOptions, report: ReportEntry[]): Promise<void> {
  const { inventory, state, api, dryRun, vaultPath } = opts;

  let wsLimit = Infinity;
  if (!dryRun) {
    try {
      const me = await api.getMe();
      wsLimit = me.bot?.workspace_limits?.max_file_upload_size_in_bytes ?? Infinity;
    } catch {
      wsLimit = Infinity;
    }
  }

  for (const note of inventory.notes) {
    const noteState = state.getNote(note.path);
    if (!noteState || noteState.status !== 'linked' || !noteState.pageId) continue;

    const ctx = buildResolvers(inventory, note.path);
    const reconverted = convertNote(note.content, ctx);

    if (reconverted.pendingFiles.length === 0) {
      await state.setNote(note.path, { ...noteState, status: 'done' });
      continue;
    }

    for (const file of reconverted.pendingFiles) {
      if (!file.targetPath) continue; // 未解決添付はPass1で警告済み

      const existingFile = state.getFile(file.targetPath);
      let fileUploadId = existingFile?.fileUploadId;

      if (!fileUploadId || existingFile?.status === 'failed') {
        const absPath = path.join(vaultPath, file.targetPath);
        try {
          const stat = dryRun ? { size: 0 } : await fs.stat(absPath);
          if (stat.size > wsLimit) {
            await state.setFile(file.targetPath, { status: 'skipped', error: 'ワークスペースのファイルサイズ上限超過' });
            report.push({ category: 'oversized_file', path: file.targetPath, message: 'ワークスペースのファイルサイズ上限を超過したためスキップしました' });
            continue;
          }
          fileUploadId = await uploadFile(api, absPath, stat.size, dryRun);
          await state.setFile(file.targetPath, { status: 'uploaded', fileUploadId });
        } catch (err) {
          await state.setFile(file.targetPath, { status: 'failed', error: String(err) });
          report.push({ category: 'warning', path: file.targetPath, message: `アップロードに失敗: ${String(err)}` });
          continue;
        }
      }

      if (dryRun) {
        await state.setFile(file.targetPath, { status: 'attached', fileUploadId });
        continue;
      }

      try {
        const children = await api.getBlockChildren(noteState.pageId);
        const placeholderBlock = children.results.find(
          (b) => b.type === 'paragraph' && JSON.stringify(b).includes(file.placeholder),
        );
        if (!placeholderBlock) {
          report.push({ category: 'warning', path: note.path, message: `添付プレースホルダーが見つかりませんでした: ${file.placeholder}` });
          continue;
        }
        const ext = file.targetPath.split('.').pop() ?? '';
        await api.appendBlockChildren(noteState.pageId, [buildAttachmentBlock(fileUploadId!, ext)], placeholderBlock.id);
        await api.deleteBlock(placeholderBlock.id);
        await state.setFile(file.targetPath, { status: 'attached', fileUploadId });
      } catch (err) {
        report.push({ category: 'warning', path: note.path, message: `添付ブロック挿入に失敗: ${String(err)}` });
      }
    }

    await state.setNote(note.path, { ...state.getNote(note.path)!, status: 'done' });
  }
}

export async function runMigration(opts: MigratorOptions): Promise<ReportEntry[]> {
  const report: ReportEntry[] = [];
  for (const skipped of opts.inventory.skipped) {
    report.push({ category: 'skipped', path: skipped.path, message: skipped.reason });
  }
  for (const warning of opts.inventory.warnings) {
    report.push({
      category: 'warning',
      path: warning.sourcePath,
      message: warning.reason === 'ambiguous'
        ? `リンク "${warning.linkText}" は複数候補があり曖昧です: ${warning.candidates?.join(', ')}`
        : `リンク先 "${warning.linkText}" が見つかりませんでした`,
    });
  }

  const containers = await createFolderContainers(opts, report);
  await runPass1(opts, containers, report);
  await runPass2(opts, report);
  await runPass3(opts, report);
  return report;
}

export function noteRecordByPath(notes: NoteRecord[], p: string): NoteRecord | undefined {
  return notes.find((n) => n.path === p);
}
