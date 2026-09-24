import type { FolderPlan, MigrationPlan, VaultInventory } from './types.js';
import { buildFrontmatterMappingsForFolder } from './property-mapping.js';

export interface PlannerOptions {
  parentPageId: string;
  /** フォルダ直下ノートのうち共通キーを持つ割合の閾値（デフォルト0.6） */
  dbSuggestionRatio?: number;
  /** database提案に必要な共通frontmatterキー数（デフォルト3） */
  dbSuggestionMinKeys?: number;
  skipList?: string[];
  /** ノート埋め込みの扱い（#80）。省略時は plan に書かず 'link' 相当 */
  embedMode?: 'link' | 'inline';
  /** ノート間リンクの形式（#142）。省略時は plan に書かず mention 相当 */
  linkStyle?: 'mention' | 'link';
}

/**
 * F2 DB化自動提案: フォルダ直下ノートの60%以上が共通のfrontmatterキーを3つ以上持つ場合、
 * database モードを提案する。最終決定は必ずユーザー（ここでは提案のみ行う）。
 */
export function suggestFolderModes(inventory: VaultInventory, opts: PlannerOptions = { parentPageId: '' }): FolderPlan[] {
  const ratio = opts.dbSuggestionRatio ?? 0.6;
  const minKeys = opts.dbSuggestionMinKeys ?? 3;

  const folders: FolderPlan[] = [];
  for (const [folderPath, notePaths] of Object.entries(inventory.folderTree)) {
    if (notePaths.length === 0) {
      folders.push({ folderPath, mode: 'page_tree' });
      continue;
    }
    const notesByPath = new Map(inventory.notes.map((n) => [n.path, n]));
    const keyCounts = new Map<string, number>();
    for (const p of notePaths) {
      const note = notesByPath.get(p);
      if (!note) continue;
      for (const key of Object.keys(note.frontmatter)) {
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
    }
    const threshold = notePaths.length * ratio;
    const commonKeys = [...keyCounts.entries()].filter(([, count]) => count >= threshold);

    if (commonKeys.length >= minKeys) {
      folders.push({
        folderPath,
        mode: 'database',
        suggestionReason: `直下${notePaths.length}ノート中${Math.max(...commonKeys.map(([, c]) => c))}以上が共通キー[${commonKeys.map(([k]) => k).join(', ')}]を保持`,
      });
    } else {
      folders.push({ folderPath, mode: 'page_tree' });
    }
  }
  return folders.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
}

export function buildPlan(inventory: VaultInventory, opts: PlannerOptions): MigrationPlan {
  const folders = suggestFolderModes(inventory, opts);
  const notesByPath = new Map(inventory.notes.map((n) => [n.path, n]));

  const frontmatterMappings: Record<string, MigrationPlan['frontmatterMappings'][string]> = {};
  for (const folder of folders) {
    if (folder.mode !== 'database') continue;
    const notePaths = inventory.folderTree[folder.folderPath] ?? [];
    const fms = notePaths.map((p) => notesByPath.get(p)?.frontmatter ?? {});
    frontmatterMappings[folder.folderPath] = buildFrontmatterMappingsForFolder(fms);
  }

  return {
    version: 1,
    vaultPath: inventory.vaultPath,
    parentPageId: opts.parentPageId,
    folders,
    frontmatterMappings,
    skipList: opts.skipList ?? inventory.skipped.map((s) => s.path),
    ...(opts.embedMode ? { embedMode: opts.embedMode } : {}),
    ...(opts.linkStyle ? { linkStyle: opts.linkStyle } : {}),
  };
}

/** Notion Free プラン（複数メンバー）の生涯ブロック上限。https://developers.notion.com/reference/workspace-block-limits */
export const FREE_PLAN_BLOCK_LIMIT = 1000;

/**
 * 移行で作成される Notion ブロック数の概算。段落・リスト項目・見出し等はおおむね1行1ブロック、
 * 添付は1ブロック、フォルダページ/DBは1ブロックとして数える（コードブロックや表は行数分だけ
 * 多めに見積もられる。Free プランのブロック上限に当たるかどうかの事前警告に使う目的なので、
 * 少なめに出るより多めに出る方向に倒している）。
 */
export function estimateBlockCount(inventory: VaultInventory): number {
  let blocks = 0;
  for (const note of inventory.notes) {
    for (const line of note.content.split('\n')) {
      if (line.trim() !== '') blocks += 1;
    }
    // frontmatter のメタ callout（page_tree モード）
    if (Object.keys(note.frontmatter).length > 0) blocks += 1;
  }
  blocks += inventory.attachments.length;
  blocks += Object.keys(inventory.folderTree).filter((f) => f !== '').length;
  return blocks;
}

/** 推定ブロック数が Free プランの上限を超えるときの事前警告文（超えなければ null） */
export function blockLimitWarning(estimatedBlocks: number): string | null {
  if (estimatedBlocks <= FREE_PLAN_BLOCK_LIMIT) return null;
  return (
    `推定ブロック数 ${estimatedBlocks.toLocaleString()} は Notion Free プラン（複数メンバー）の生涯上限 ` +
    `${FREE_PLAN_BLOCK_LIMIT.toLocaleString()} ブロックを超えています。移行先が Free プランで複数メンバーの場合、` +
    '上限到達時点で移行は中断されます（削除しても枠は戻りません）。有料プランへのアップグレード、' +
    'メンバーを1人にする、または個人アクセストークン（PAT。上限の対象外）の利用を検討してください。'
  );
}
