import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildAliasIndex, buildNameIndex, resolveByFilename, resolveNoteLink } from './scanner.js';
import { convertNote, ESCAPE_SENTINEL, ESCAPE_TARGET, type ConverterContext, type EmbedMode } from './converter.js';
import { NotionApiError, NotionBlockLimitError, type NotionApi, type NotionBlock, type PageCover, type PageIcon, type UpdateContentItem } from './notion-client.js';
import type { StateStore } from './state.js';
import { contentHash, isNoteUpToDate, stableStringify } from './state.js';
import { createDatabaseForFolder, buildRowProperties } from './notion-db.js';
import { mimeTypeFor } from './attachments.js';
import {
  buildTitleProperty,
  buildFrontmatterMetaCallout,
  splitMarkdownForPayload,
  shouldUseAsyncWrite,
  buildAttachmentBlock,
} from './notion-blocks.js';
import type { DeferredLink, MigrationPlan, NoteRecord, NoteStatus, ReportEntry, VaultInventory } from './types.js';

export interface MigratorOptions {
  vaultPath: string;
  plan: MigrationPlan;
  inventory: VaultInventory;
  api: NotionApi;
  state: StateStore;
  dryRun: boolean;
  /** ノート単位の進捗コールバック（総ノート数ベースの進捗表示用） */
  onProgress?: (done: number, total: number, notePath: string) => void;
  /** 中断要求（MCP の cancel_migration 等、#117）。ノート境界で確認し、以降を処理せず aborted として返す */
  signal?: AbortSignal;
  /**
   * マルチパートアップロードのパートサイズ（既定20 MiB = Notionの単一パート上限）。
   * テストで小さなファイルでもマルチパート経路を通すために差し替え可能にしている。
   * 実運用でNotionの規約（各パート5〜20 MiB、最終パートのみ5 MiB未満可）を外れる値を
   * 指定するとsendが400になるため変更しないこと。
   */
  multipartPartSizeBytes?: number;
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

/**
 * frontmatter の title をページタイトルの文字列にする（#140）。以前は型アサーションだけで、
 * `title: 1984` のような数値や配列がそのまま送られ validation_error、2000 字超も切り詰めていなかった
 */
export function pageTitle(raw: unknown, fallback: string): string {
  let t: string;
  if (typeof raw === 'string') t = raw;
  else if (typeof raw === 'number' || typeof raw === 'boolean') t = String(raw);
  else if (raw instanceof Date) t = raw.toISOString().slice(0, 10);
  else if (Array.isArray(raw)) t = raw.map((v) => String(v)).join(', ');
  else t = '';
  t = t.trim() || fallback;
  return Array.from(t).slice(0, 2000).join('');
}

function folderDepth(folderPath: string): number {
  return folderPath === '' ? 0 : folderPath.split('/').length;
}

/** 利用者による中断（AbortSignal）。ブロック上限と同様に「残りを処理せず中断」として扱う */
export class MigrationCancelledError extends Error {
  constructor() {
    super('利用者の要求により移行を中断しました。`o2n resume`（MCP: resume_migration）で続きから再開できます。');
    this.name = 'MigrationCancelledError';
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MigrationCancelledError();
}

interface ResolverIndexes {
  noteIndex: Map<string, string[]>;
  aliasIndex: Map<string, string[]>;
  fileIndex: Map<string, string[]>;
}

// 索引は inventory ごとに一度だけ作る（buildResolvers は各パスでノートごとに呼ばれる）
const resolverIndexCache = new WeakMap<VaultInventory, ResolverIndexes>();

function indexesFor(inventory: VaultInventory): ResolverIndexes {
  let idx = resolverIndexCache.get(inventory);
  if (!idx) {
    idx = {
      noteIndex: buildNameIndex(inventory.notes.map((n) => n.path)),
      aliasIndex: buildAliasIndex(inventory.notes),
      // 添付は vault 内の .md 以外の全ファイルから解決する（#157）。以前は scan 時に ![[…]] で見つかった
      // 添付だけから作っていたため、Markdown 形式でしか参照されない画像・ファイルが解決できなかった
      fileIndex: buildNameIndex(
        inventory.files ??
          inventory.attachments.map((a) => a.targetPath).filter((p): p is string => p !== null),
      ),
    };
    resolverIndexCache.set(inventory, idx);
  }
  return idx;
}

/**
 * ノート本文の変換結果を inventory ごとにキャッシュする（#111）。Pass1/2/3 が同じノートを
 * 3回変換していたのを1回にする。プレースホルダー番号も3パスで確実に一致する。
 */
const conversionCache = new WeakMap<VaultInventory, Map<string, ReturnType<typeof convertNote>>>();

function convertCached(inventory: VaultInventory, note: NoteRecord, embedMode: EmbedMode | undefined): ReturnType<typeof convertNote> {
  let cache = conversionCache.get(inventory);
  if (!cache) {
    cache = new Map();
    conversionCache.set(inventory, cache);
  }
  const key = `${embedMode ?? 'link'}\u0000${note.path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = convertNote(note.content, buildResolvers(inventory, note.path, embedMode));
  cache.set(key, result);
  return result;
}

function buildResolvers(inventory: VaultInventory, sourcePath: string, embedMode: EmbedMode = 'link'): ConverterContext {
  const { noteIndex, aliasIndex, fileIndex } = indexesFor(inventory);
  const ctx: ConverterContext = {
    sourcePath,
    // ファイル名一致 → frontmatter aliases の順で解決（Obsidian の挙動、#77）
    resolveNoteLink: (target: string) => resolveNoteLink(target, sourcePath, noteIndex, aliasIndex).resolved,
    resolveAttachment: (target: string) => resolveByFilename(target, sourcePath, fileIndex).resolved,
    embedMode,
  };
  if (embedMode === 'inline') {
    // インライン展開（#80）: 埋め込み先の本文と、そのノートを起点にしたリンク解決を converter に渡す
    ctx.readNote = (notePath: string) => inventory.notes.find((n) => n.path === notePath)?.content ?? null;
    ctx.contextFor = (notePath: string) => buildResolvers(inventory, notePath, embedMode);
  }
  return ctx;
}

/**
 * ノートの変更判定に使う指紋（#136）。以前は本文だけのハッシュだったため、frontmatter だけの変更
 * （DB のプロパティ、icon/cover、メタ callout）や、inline 埋め込み先ノートの変更が resume で
 * 反映されなかった。frontmatter・本文・（inline 時）埋め込み先ノート（深さ 2 まで）を含める。
 */
export function noteFingerprint(inventory: VaultInventory, note: NoteRecord, embedMode: EmbedMode | undefined): string {
  const parts = [stableStringify(note.frontmatter), note.content];
  if (embedMode === 'inline') {
    const { noteIndex, aliasIndex } = indexesFor(inventory);
    const byPath = new Map(inventory.notes.map((n) => [n.path, n]));
    const seen = new Set<string>([note.path]);
    let frontier = [note.path];
    for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const src of frontier) {
        for (const link of inventory.wikiLinks) {
          if (link.sourcePath !== src || !link.isEmbed) continue;
          const target = resolveNoteLink(link.target, src, noteIndex, aliasIndex).resolved;
          if (!target || seen.has(target)) continue;
          seen.add(target);
          next.push(target);
        }
      }
      frontier = next;
    }
    for (const p of [...seen].filter((p) => p !== note.path).sort()) parts.push(p, byPath.get(p)?.content ?? '');
  }
  return contentHash(parts.join('\u0000'));
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

    // 直下にノートが無い中間フォルダ（#135）を、以前のバージョンで移行済みの vault の resume で
    // 後から作ると、既存の子フォルダページはルート直下に残ったまま空のページだけが増える。
    // 子孫フォルダが既に作成済みなら中間フォルダは作らない（新規移行では正しい階層で作る）
    const isIntermediate = (opts.inventory.folderTree[folder.folderPath] ?? []).length === 0;
    if (isIntermediate) {
      const prefix = `${folder.folderPath}/`;
      const descendantAlreadyCreated = Object.entries(state.snapshot.folders ?? {}).some(
        ([p, f]) => p.startsWith(prefix) && f.status === 'created',
      );
      if (descendantAlreadyCreated) continue;
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
      // ブロック上限は個別の失敗ではなく移行全体の中断。state は触らず（未作成のまま）呼び出し元で中断する
      if (err instanceof NotionBlockLimitError) throw err;
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
    throwIfCancelled(opts.signal);
    if (skipSet.has(note.path)) {
      await state.setNote(note.path, { status: 'skipped' });
      done += 1;
      onProgress?.(done, total, note.path);
      continue;
    }
    const hash = noteFingerprint(inventory, note, plan.embedMode);
    const existing = state.getNote(note.path);
    if (isNoteUpToDate(existing, hash) && existing) {
      done += 1;
      onProgress?.(done, total, note.path);
      continue;
    }
    // v0.4.0 以前の state（本文だけのハッシュ）と一致する場合は、前回から本文は変わっていない。
    // frontmatter の変更有無は判別できないが、アップグレード直後に全ページを書き直さないよう
    // 変更なしとみなし、ハッシュだけ新形式に更新する（以降は frontmatter の変更も検知される）
    if (existing && isNoteUpToDate(existing, contentHash(note.content))) {
      await state.setNote(note.path, { ...existing, contentHash: hash });
      done += 1;
      onProgress?.(done, total, note.path);
      continue;
    }

    const folder = folderOf(note.path);
    const container = containers.get(folder) ?? { kind: 'page' as const, id: plan.parentPageId };

    const converted = convertCached(inventory, note, plan.embedMode);
    report.push(...converted.entries);
    if (note.excalidraw) {
      report.push({
        category: 'downgraded',
        path: note.path,
        message: `Excalidraw の図面は編集不可の画像（${note.excalidraw.exportedImage}）として移行しました`,
      });
    }

    const title = pageTitle(note.frontmatter.title, basenameNoExt(note.path));

    let markdown: string;
    let properties: Record<string, unknown>;
    let parent: { page_id: string } | { type: 'data_source_id'; data_source_id: string };

    if (container.kind === 'database' && container.dataSourceId) {
      const row = buildRowProperties(note.frontmatter, plan.frontmatterMappings[folder] ?? [], title);
      properties = row.properties;
      // 上限で切り詰め・省略した値は、page_treeモードと同じメタcalloutで本文冒頭に全文を退避する
      // （該当キーのみ。正常に入ったプロパティまで重複させない）
      if (row.issues.length > 0) {
        const retained: Record<string, unknown> = {};
        for (const issue of row.issues) {
          retained[issue.key] = note.frontmatter[issue.key];
          report.push({ category: 'downgraded', path: note.path, message: `プロパティ "${issue.key}": ${issue.message}` });
        }
        markdown = buildFrontmatterMetaCallout(retained) + converted.markdown;
      } else {
        markdown = converted.markdown;
      }
      parent = { type: 'data_source_id', data_source_id: container.dataSourceId };
    } else {
      markdown = converted.markdown; // メタ callout は装飾の判定後に付ける（下記）
      properties = { title: buildTitleProperty(title) };
      parent = { page_id: container.id };
    }

    // frontmatter の icon / cover（banner）をページのアイコン・カバーに反映する（#113）。
    // 反映できたキーはメタ callout から除き、解釈できない値（Iconize のアイコン名等）はそのまま残す
    const decoration = dryRun ? {} : await resolvePageDecoration(api, inventory, note, vaultPath, report);
    if (!(container.kind === 'database' && container.dataSourceId)) {
      const omit = new Set<string>();
      if (decoration.icon) omit.add('icon');
      if (decoration.cover) {
        omit.add('cover');
        omit.add('banner');
      }
      markdown = buildFrontmatterMetaCallout(note.frontmatter, omit) + converted.markdown;
    }

    const chunks = splitMarkdownForPayload(markdown, {
      onOversizedUnit: (message) => report.push({ category: 'warning', path: note.path, message }),
    });

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

      if (existing?.pageId && existing.status !== 'failed') {
        // 既存ページがあり本文が変わった（resume 時にノートを編集していた）: 新規作成せず
        // 同じページを更新する（#105）。従来は別ページを作って旧ページが孤立していた。
        // 子ページ/DB を含むページの replace_content は Notion 側が validation_error にする
        // （allow_deleting_content を付けない）ため、その場合は警告して state を据え置く
        try {
          await api.updatePageProperties(existing.pageId, properties, decoration);
          await api.updatePageMarkdown(existing.pageId, { type: 'replace_content', replace_content: { new_str: chunks[0] ?? '' } });
          for (const chunk of chunks.slice(1)) {
            await api.updatePageMarkdown(existing.pageId, { type: 'insert_content', insert_content: { content: chunk, position: { type: 'end' } } });
          }
        } catch (err) {
          if (err instanceof NotionBlockLimitError) throw err;
          report.push({ category: 'warning', path: note.path, message: `変更されたノートのページ更新に失敗したため前回の内容のまま残しました: ${String(err)}` });
          done += 1;
          onProgress?.(done, total, note.path);
          continue;
        }
        // 添付・リンクは新しい本文のプレースホルダーに対して Pass2/3 で再解決する
        await state.setNote(note.path, { status: 'created', pageId: existing.pageId, pageUrl: existing.pageUrl, contentHash: hash });
        report.push({ category: 'downgraded', path: note.path, message: '前回の移行後に変更されたため、Notion 上の同じページの本文を置き換えました' });
        done += 1;
        onProgress?.(done, total, note.path);
        continue;
      }

      const page = await api.createPageMarkdown({ parent, markdown: chunks[0], properties });
      // 実ワークスペース確認（2026-09-21）: POST /pages（markdown）に cover を同梱しても反映されない
      // ケースがあったため、装飾は作成後に PATCH /pages/:id で別途適用する
      if (decoration.icon || decoration.cover) await api.updatePageProperties(page.id, {}, decoration);
      for (const chunk of chunks.slice(1)) {
        await api.updatePageMarkdown(
          page.id,
          { type: 'insert_content', insert_content: { content: chunk, position: { type: 'end' } } },
          shouldUseAsyncWrite(chunk),
        );
      }
      await state.setNote(note.path, { status: 'created', pageId: page.id, pageUrl: page.url, contentHash: hash });
    } catch (err) {
      // ブロック上限（#70）: 残りのノートも全て同じ理由で失敗するので、1ノートごとに無駄な
      // リクエストを送らず即座に中断する。このノートの state は未着手のまま残すため、
      // プラン変更後に resume すればここから続きを処理できる。
      if (err instanceof NotionBlockLimitError) throw err;
      await state.setNote(note.path, { status: 'failed', contentHash: hash, error: String(err) });
      report.push({ category: 'warning', path: note.path, message: `ページ作成に失敗: ${String(err)}` });
    }
    done += 1;
    onProgress?.(done, total, note.path);
  }
  void vaultPath;
}

function isPageReady(status: NoteStatus): boolean {
  return status === 'created' || status === 'linked' || status === 'attached' || status === 'done';
}

/**
 * 以前の実行で「リンク先のページが未作成」のため元表記（`[[X]]`）のまま残したリンクを、リンク先の
 * ページができた後に書き換える（#139）。update_content は `[[X]]` のような文字列を一致させられない
 * （実ワークスペースで確認）ため、ページのブロックを取得し、その文字列を含む text run を分割して
 * リンク付きの run に置き換える。複数の run にまたがる（一部だけ太字等）場合は書き換えられないので残す。
 */
async function resolveDeferredLinks(opts: MigratorOptions, report: ReportEntry[]): Promise<void> {
  const { inventory, state, api, dryRun } = opts;
  if (dryRun) return;
  for (const note of inventory.notes) {
    throwIfCancelled(opts.signal);
    const noteState = state.getNote(note.path);
    const deferred = noteState?.deferredLinks;
    if (!noteState?.pageId || !deferred || deferred.length === 0) continue;
    const ready = deferred.filter((d) => {
      const t = state.getNote(d.targetPath);
      return Boolean(t?.pageUrl && isPageReady(t.status));
    });
    if (ready.length === 0) continue;

    const wanted = new Set(ready.map((d) => d.text));
    let blocks: NotionBlock[];
    try {
      blocks = await collectTextBlocks(api, noteState.pageId, wanted);
    } catch (err) {
      report.push({ category: 'warning', path: note.path, message: `保留リンクの書き換え用にブロックを取得できませんでした: ${String(err)}` });
      continue;
    }
    const done = new Set<DeferredLink>();
    for (const block of blocks) {
      const payload = block[block.type] as { rich_text?: RichTextRun[] } | undefined;
      let runs = payload?.rich_text;
      if (!Array.isArray(runs)) continue;
      let changed = false;
      for (const d of ready) {
        const url = state.getNote(d.targetPath)!.pageUrl!;
        const next: RichTextRun[] = [];
        for (const r of runs) {
          const content = r.text?.content;
          if (r.type === 'text' && content?.includes(d.text) && !r.text?.link) {
            const pieces = content.split(d.text);
            pieces.forEach((piece, i) => {
              if (piece) next.push({ ...r, text: { ...r.text!, content: piece }, plain_text: piece });
              if (i < pieces.length - 1) next.push({ ...r, text: { content: d.displayText, link: { url } }, plain_text: d.displayText, href: url });
            });
            changed = true;
            done.add(d);
          } else {
            next.push(r);
          }
        }
        runs = next;
      }
      if (changed) {
        const clean = runs.map(({ plain_text: _p, href: _h, ...rest }) => rest);
        await api.updateBlock(block.id, { [block.type]: { rich_text: clean } });
      }
    }
    for (const d of ready.filter((x) => !done.has(x))) {
      report.push({ category: 'warning', path: note.path, message: `保留していたリンク "${d.text}" を本文中で見つけられず書き換えられませんでした（書式が一部だけ変わっている等）` });
    }
    // 書き換えた・見つからなかったものは保留を解除し、リンク先がまだ未作成のものだけ次回に残す
    const stillWaiting = deferred.filter((d) => !ready.includes(d));
    await state.setNote(note.path, { ...state.getNote(note.path)!, deferredLinks: stillWaiting.length > 0 ? stillWaiting : undefined });
  }
}

/** 指定の文字列のいずれかを含むブロックを（ネストも含めて）集める */
async function collectTextBlocks(api: NotionApi, pageId: string, wanted: Set<string>, maxDepth = 3): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  async function walk(blockId: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    for (const block of await api.listAllBlockChildren(blockId)) {
      const json = JSON.stringify(block);
      if ([...wanted].some((w) => json.includes(JSON.stringify(w).slice(1, -1)))) out.push(block);
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') await walk(block.id, depth + 1);
    }
  }
  await walk(pageId, 1);
  return out;
}

/**
 * リンクの表示テキストがリンク先ノートの名前（ファイル名 or タイトル）そのものか。メンションはリンク先の
 * タイトルを表示するため、aliases 経由の `[[別名]]` などをメンションにすると書いた文字と違う表示になる
 */
function showsTargetName(inventory: VaultInventory, targetPath: string, displayText: string): boolean {
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  const shown = norm(path.posix.basename(displayText).replace(/\.md$/i, ''));
  const target = inventory.notes.find((n) => n.path === targetPath);
  return shown === norm(basenameNoExt(targetPath)) || (target !== undefined && shown === norm(pageTitle(target.frontmatter.title, '')));
}

/** 見出しの比較用の正規化（Obsidian はリンク中の `#^|:%[]` 等を空白に置き換えるため、両側を揃える） */
export function normalizeHeading(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[#^|:%[\]\\*_`~]/g, ' ').replace(/\s+/g, ' ').trim();
}

const HEADING_TYPES = new Set(['heading_1', 'heading_2', 'heading_3', 'heading_4']);

/** ページの見出しブロック（トグル見出し・列の中も含め深さ 2 まで）を 正規化テキスト → ブロックID で返す */
async function headingIndex(api: NotionApi, pageId: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  async function walk(blockId: string, depth: number): Promise<void> {
    for (const block of await api.listAllBlockChildren(blockId)) {
      if (HEADING_TYPES.has(block.type)) {
        const runs = (block[block.type] as { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> } | undefined)?.rich_text ?? [];
        const key = normalizeHeading(runs.map((r) => r.plain_text ?? r.text?.content ?? '').join(''));
        if (key && !index.has(key)) index.set(key, block.id);
      }
      if (depth < 2 && block.has_children && block.type !== 'child_page' && block.type !== 'child_database') await walk(block.id, depth + 1);
    }
  }
  await walk(pageId, 1);
  return index;
}

async function runPass2(opts: MigratorOptions, report: ReportEntry[]): Promise<void> {
  const { plan, inventory, state, api, dryRun } = opts;
  const linkStyle = plan.linkStyle ?? 'mention';
  // 見出しリンクの解決用に、リンク先ページの見出し一覧をページごとに1回だけ取得する（#143）
  const headingCache = new Map<string, Promise<Map<string, string>>>();
  const headingsOf = (pageId: string) => {
    let p = headingCache.get(pageId);
    if (!p) {
      p = headingIndex(api, pageId);
      headingCache.set(pageId, p);
    }
    return p;
  };

  for (const note of inventory.notes) {
    throwIfCancelled(opts.signal);
    const noteState = state.getNote(note.path);
    if (!noteState || noteState.status !== 'created' || !noteState.pageId) continue;

    const reconverted = convertCached(inventory, note, plan.embedMode);

    const updates: UpdateContentItem[] = [];
    const deferred: DeferredLink[] = [];
    for (const link of reconverted.pendingLinks) {
      const targetState = link.targetPath ? state.getNote(link.targetPath) : undefined;
      let newStr: string;
      if (targetState?.pageUrl && isPageReady(targetState.status)) {
        let url = targetState.pageUrl;
        if (link.heading) {
          // 見出しリンク（#143）: `ページURL#ブロックID` で見出しそのものに移動できる（実ワークスペースで確認）
          let blockId: string | undefined;
          if (!dryRun && targetState.pageId) {
            try {
              blockId = (await headingsOf(targetState.pageId)).get(normalizeHeading(link.heading.split('#').pop() ?? link.heading));
            } catch {
              blockId = undefined;
            }
          }
          if (blockId) {
            url = `${targetState.pageUrl.split('#')[0]}#${blockId.replace(/-/g, '')}`;
          } else if (!dryRun) {
            report.push({ category: 'downgraded', path: note.path, message: `見出し "${link.heading}" がリンク先 "${link.targetPath}" に見つからないため、ページ先頭へのリンクにしました` });
          }
          newStr = `[${link.displayText}](${url})`;
        } else if (linkStyle === 'mention' && link.mentionable && link.targetPath && showsTargetName(inventory, link.targetPath, link.displayText)) {
          // ページメンション（#142）: URL リンクと違い Notion のバックリンクに現れ、リンク先の改名にも追従する
          newStr = `<mention-page url="${url}"/>`;
        } else {
          newStr = `[${link.displayText}](${url})`;
        }
      } else {
        newStr = link.fallbackText;
        if (link.targetPath && targetState?.status !== 'skipped') {
          // リンク先は vault にあるがページ作成に失敗している（#139）。resume でリンク先が成功したら書き換える
          deferred.push({ targetPath: link.targetPath, text: link.fallbackText, displayText: link.displayText });
          report.push({ category: 'unresolved_link', path: note.path, message: `リンク先 "${link.targetPath}" のページが未作成のため "${link.fallbackText}" のまま残しました（resume でリンク先が作成されると自動でリンクになります）` });
        } else {
          report.push({ category: 'unresolved_link', path: note.path, message: `リンク "${link.fallbackText}" は解決できず元表記に戻しました` });
        }
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
      await state.setNote(note.path, { ...noteState, status: 'linked', ...(deferred.length > 0 ? { deferredLinks: deferred } : { deferredLinks: undefined }) });
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

/**
 * §16検証済み（2026-07-19）: createFileUpload時にcontent_typeを指定しないと、
 * send時にNotionが「作成時に決定された元のcontent typeと一致しない」として400を返す。
 * 作成時とBlobのtypeの両方で同じMIMEタイプを明示する必要がある。
 * さらに、作成直後（数百ms以内）にsendすると同じ400エラーが発生するケースが実ワークスペースで
 * 確認された（file_uploadレコードの反映にタイムラグがあると見られる）。sendを1回リトライする
 * ことで回避する。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(api: NotionApi, uploadId: string, buildForm: () => FormData): Promise<void> {
  try {
    await api.sendFileUpload(uploadId, buildForm());
  } catch (err) {
    if (err instanceof NotionApiError && err.status === 400 && /content type/i.test(err.message)) {
      await sleep(1000);
      await api.sendFileUpload(uploadId, buildForm());
      return;
    }
    throw err;
  }
}

const EMOJI_ONLY_RE = /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*$/u;

/**
 * frontmatter の `icon`（絵文字 or 画像URL/vault内画像）と `cover` / `banner`（画像URL/vault内画像）を
 * Notion のページ装飾に変換する（#113）。vault 内の画像は File Upload API でアップロードする。
 * Iconize プラグインのアイコン名（`LiCoffee` 等）のように解釈できない値は無視して callout に残す。
 */
async function resolvePageDecoration(
  api: NotionApi,
  inventory: VaultInventory,
  note: NoteRecord,
  vaultPath: string,
  report: ReportEntry[],
): Promise<{ icon?: PageIcon; cover?: PageCover }> {
  const out: { icon?: PageIcon; cover?: PageCover } = {};
  const fm = note.frontmatter;
  const { fileIndex } = indexesFor(inventory);

  const asImage = async (raw: unknown, kind: 'icon' | 'cover'): Promise<PageIcon | PageCover | undefined> => {
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim().replace(/^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/, '$1');
    if (/^https?:\/\//i.test(value)) return { type: 'external', external: { url: value } };
    // 本文から参照されていない画像は添付索引に無いので、vault ルート／ノートのフォルダからの相対パスも試す
    const candidates = [
      resolveByFilename(value, note.path, fileIndex).resolved,
      value.replace(/^\/+/, ''),
      path.posix.join(path.posix.dirname(note.path), value),
    ].filter((c): c is string => typeof c === 'string' && c.length > 0 && !c.includes('..'));
    let resolved: string | undefined;
    for (const c of candidates) {
      try {
        const st = await fs.stat(path.join(vaultPath, c));
        if (st.isFile()) {
          resolved = c;
          break;
        }
      } catch {
        // 次の候補へ
      }
    }
    if (!resolved) return undefined;
    try {
      const absPath = path.join(vaultPath, resolved);
      const stat = await fs.stat(absPath);
      const id = await uploadFile(api, absPath, stat.size, false);
      return { type: 'file_upload', file_upload: { id } };
    } catch (err) {
      report.push({ category: 'warning', path: note.path, message: `${kind} 画像 "${value}" のアップロードに失敗: ${String(err)}` });
      return undefined;
    }
  };

  if (typeof fm.icon === 'string' && EMOJI_ONLY_RE.test(fm.icon.trim())) {
    out.icon = { type: 'emoji', emoji: fm.icon.trim() };
  } else {
    const icon = await asImage(fm.icon, 'icon');
    if (icon) out.icon = icon;
  }
  const cover = (await asImage(fm.cover, 'cover')) ?? (await asImage(fm.banner, 'cover'));
  if (cover && cover.type !== 'emoji') out.cover = cover;
  return out;
}

async function uploadFile(
  api: NotionApi,
  absPath: string,
  size: number,
  dryRun: boolean,
  partSize: number = SINGLE_PART_LIMIT,
): Promise<string> {
  const filename = path.basename(absPath);
  if (dryRun) return `dry-run-upload-${filename}`;
  const contentType = mimeTypeFor(filename);

  if (size <= partSize) {
    const created = await api.createFileUpload({ filename, content_type: contentType, mode: 'single_part' });
    const buf = await fs.readFile(absPath);
    await sendWithRetry(api, created.id, () => {
      const form = new FormData();
      form.append('file', new Blob([buf], { type: contentType }), filename);
      return form;
    });
    return created.id;
  }

  // マルチパート: §4.1。各パートを part_number 付きで送り、最後に /complete を呼ぶ
  // （complete を呼ばないとアップロードが pending のまま完了しない。docs/questions.md §5）
  const numberOfParts = Math.ceil(size / partSize);
  const created = await api.createFileUpload({ filename, content_type: contentType, mode: 'multi_part', number_of_parts: numberOfParts });
  const fh = await fs.open(absPath, 'r');
  try {
    for (let i = 0; i < numberOfParts; i += 1) {
      const thisPartSize = Math.min(partSize, size - i * partSize);
      const buf = Buffer.alloc(thisPartSize);
      await fh.read(buf, 0, thisPartSize, i * partSize);
      await sendWithRetry(api, created.id, () => {
        const form = new FormData();
        form.append('file', new Blob([buf], { type: contentType }), filename);
        form.append('part_number', String(i + 1));
        return form;
      });
    }
  } finally {
    await fh.close();
  }
  const completed = await api.completeFileUpload(created.id);
  if (completed.status && completed.status !== 'uploaded') {
    throw new Error(`マルチパートアップロードが完了しませんでした (status: ${completed.status})`);
  }
  return created.id;
}

interface PlaceholderLocation {
  blockId: string;
  /** プレースホルダーブロックの直接の親（ページ本体ならページID）。after_block で挿入する際の親に使う */
  parentId: string;
  /** プレースホルダーを含むブロック本体（type とその rich_text）。他のテキストと同居しているか判定するため保持 */
  block: NotionBlock;
}

interface RichTextRun {
  type?: string;
  text?: { content: string; link?: unknown };
  plain_text?: string;
  [k: string]: unknown;
}

/**
 * プレースホルダーが「そのブロックの唯一の内容」でない（文中に `[資料](a.pdf)` のように他の文字と
 * 同居している）場合、ブロックごと削除すると周囲の文章が消える。その場合はプレースホルダー文字列だけを
 * 取り除いた rich_text を返す。唯一の内容なら null（＝ブロックを削除してよい）。
 */
function richTextWithoutPlaceholder(block: NotionBlock, placeholder: string): RichTextRun[] | null {
  const payload = block[block.type] as { rich_text?: RichTextRun[] } | undefined;
  const runs = payload?.rich_text;
  if (!Array.isArray(runs)) return null;
  const plain = runs.map((r) => r.text?.content ?? r.plain_text ?? '').join('');
  if (plain.trim() === placeholder) return null;
  const cleaned = runs
    .map((r) => (r.text ? { ...r, text: { ...r.text, content: r.text.content.split(placeholder).join('') } } : r))
    .filter((r) => !r.text || r.text.content.length > 0);
  return cleaned;
}

/**
 * ページ内から添付プレースホルダーを含むブロックを探し、placeholder → { blockId, parentId } の対応を返す。
 * 実ワークスペースで確認（2026-09-20、#82）: ネストしたリスト項目内のプレースホルダーの直後に挿入するには
 * `PATCH /blocks/{直接の親}/children` に after_block を渡す必要があり、ページIDを親にすると
 * 400 "Block ID … to append children after is not parented by …" になる。
 * - 子ブロック一覧はページネーションで全件取得する（100ブロック超対応）
 * - ネストしたリスト項目など `has_children` のブロックは再帰して探す（深さ上限 maxDepth）。
 *   ただし子ページ/子DBの中には入らない
 * - 探しているプレースホルダーが全て見つかった時点で打ち切り、無駄なGETを避ける
 */
async function findPlaceholderBlocks(
  api: NotionApi,
  pageId: string,
  wanted: Set<string>,
  maxDepth = 3,
): Promise<Map<string, PlaceholderLocation>> {
  const found = new Map<string, PlaceholderLocation>();
  const remaining = new Set(wanted);

  async function search(blockId: string, depth: number): Promise<void> {
    if (remaining.size === 0 || depth > maxDepth) return;
    const children = await api.listAllBlockChildren(blockId);
    const toDescend: NotionBlock[] = [];
    for (const block of children) {
      // §16検証済み: プレースホルダーは paragraph 以外（bulleted_list_item 等）にも入るため型を限定しない
      const json = JSON.stringify(block);
      for (const ph of remaining) {
        if (json.includes(ph)) {
          found.set(ph, { blockId: block.id, parentId: blockId, block });
          remaining.delete(ph);
        }
      }
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        toDescend.push(block);
      }
    }
    for (const block of toDescend) {
      if (remaining.size === 0) return;
      await search(block.id, depth + 1);
    }
  }

  await search(pageId, 1);
  return found;
}

async function runPass3(opts: MigratorOptions, report: ReportEntry[]): Promise<void> {
  const { plan, inventory, state, api, dryRun, vaultPath } = opts;

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
    throwIfCancelled(opts.signal);
    const noteState = state.getNote(note.path);
    // 'done'も対象に含めるのは、resume時に前回失敗した添付だけを再試行できるようにするため
    // （一度'done'になったノートをPass3が二度と見に行かないと、失敗した添付が永遠に直らない）
    if (!noteState || !noteState.pageId || (noteState.status !== 'linked' && noteState.status !== 'done')) continue;

    const reconverted = convertCached(inventory, note, plan.embedMode);

    if (reconverted.pendingFiles.length === 0) {
      await state.setNote(note.path, { ...noteState, status: 'done' });
      continue;
    }

    const attachedPlaceholders = new Set(noteState.attachedPlaceholders ?? []);

    // このノートで今回ブロック置換が必要なプレースホルダーを先に集め、子ブロックの取得は
    // ノートにつき1回にまとめる（以前はプレースホルダーごとにGETしていた）。
    const lookupTargets = new Set<string>();
    for (const file of reconverted.pendingFiles) {
      if (!file.targetPath || attachedPlaceholders.has(file.placeholder)) continue;
      if (state.getFile(file.targetPath)?.status === 'skipped') continue;
      lookupTargets.add(file.placeholder);
    }
    let placeholderBlocks = new Map<string, PlaceholderLocation>();
    if (!dryRun && lookupTargets.size > 0) {
      try {
        placeholderBlocks = await findPlaceholderBlocks(api, noteState.pageId, lookupTargets);
      } catch (err) {
        report.push({ category: 'warning', path: note.path, message: `子ブロックの取得に失敗: ${String(err)}` });
        continue;
      }
    }

    for (const file of reconverted.pendingFiles) {
      if (!file.targetPath) continue; // 未解決添付はPass1で警告済み

      // この箇所（プレースホルダー）は前回の実行で既に貼り付け・削除済み。
      // resumeでPass3が'done'ノートを再訪しても、置換済みプレースホルダーは
      // もう本文に存在しないため誤って「見つからない」警告を出さないようにする。
      if (attachedPlaceholders.has(file.placeholder)) continue;

      const existingFile = state.getFile(file.targetPath);
      // 'skipped'（サイズ超過）はファイル単位で確定した結果なので毎回スキップする。
      // 'attached'はこのファイル自体のアップロードが完了済みという意味でしかなく、
      // 同じファイルへの2箇所目以降の埋め込み（別のplaceholder）はまだブロック置換が
      // 済んでいない可能性があるため、ここでは早期continueしない（実ワークスペースで
      // 発覚した不具合: 同じ添付を複数回参照すると2回目以降のプレースホルダーが
      // 置換されないまま残っていた）。
      if (existingFile?.status === 'skipped') continue;

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
          fileUploadId = await uploadFile(api, absPath, stat.size, dryRun, opts.multipartPartSizeBytes);
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
        const location = placeholderBlocks.get(file.placeholder);
        if (!location) {
          // この修正より前に作られたstate.json（attachedPlaceholders未記録）は、
          // 過去の実行で正常に貼り付け済みでも記録が残っていない。ファイル自体が
          // 既に'attached'なら「見つからない」のは過去の正常完了である可能性が高いため、
          // 誤警告にせず記録だけ補完する（自己修復）。
          if (existingFile?.status === 'attached') {
            attachedPlaceholders.add(file.placeholder);
            await state.setNote(note.path, { ...state.getNote(note.path)!, attachedPlaceholders: [...attachedPlaceholders] });
            continue;
          }
          report.push({ category: 'warning', path: note.path, message: `添付プレースホルダーが見つかりませんでした: ${file.placeholder}` });
          continue;
        }
        const ext = file.targetPath.split('.').pop() ?? '';
        await api.appendBlockChildren(location.parentId, [buildAttachmentBlock(fileUploadId!, ext)], location.blockId);
        const remaining = richTextWithoutPlaceholder(location.block, file.placeholder);
        if (remaining === null) {
          await api.deleteBlock(location.blockId);
        } else {
          // 文中の添付リンク: 周囲の文章を残してプレースホルダーだけ消す（#109 で発覚、v0.3.1）
          await api.updateBlock(location.blockId, { [location.block.type]: { rich_text: remaining } });
          // 同じブロックに別のプレースホルダーが残っている場合に備え、保持している本文も更新する
          (location.block[location.block.type] as { rich_text?: RichTextRun[] }).rich_text = remaining;
        }
        await state.setFile(file.targetPath, { status: 'attached', fileUploadId });
        attachedPlaceholders.add(file.placeholder);
        await state.setNote(note.path, { ...state.getNote(note.path)!, attachedPlaceholders: [...attachedPlaceholders] });
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

  try {
    const containers = await createFolderContainers(opts, report);
    await runPass1(opts, containers, report);
    await runPass2(opts, report);
    await resolveDeferredLinks(opts, report);
    await runPass3(opts, report);
  } catch (err) {
    if (!(err instanceof NotionBlockLimitError) && !(err instanceof MigrationCancelledError)) throw err;
    // ブロック上限: Pass2（リンク解決）は続行できるが Pass3（添付ブロック挿入）は同じ上限に当たる。
    // 利用者の中断: 即座に止める。いずれも中断として報告し、resume で再開できる状態で返す
    report.push({ category: 'aborted', path: '', message: err.message });
    await opts.state.flush();
    return report;
  }
  await opts.state.flush();
  return report;
}

/** 移行が途中で中断されたか（ブロック上限・利用者の中断） */
export function wasAborted(entries: ReportEntry[]): boolean {
  return entries.some((e) => e.category === 'aborted');
}

/** 移行がブロック上限で中断されたか（CLI/MCP が終了コードやメッセージを出し分けるため） */
export function wasAbortedByBlockLimit(entries: ReportEntry[]): boolean {
  return entries.some((e) => e.category === 'aborted');
}

export function noteRecordByPath(notes: NoteRecord[], p: string): NoteRecord | undefined {
  return notes.find((n) => n.path === p);
}
