import type { FolderPlan, MigrationPlan, VaultInventory } from './types.js';
import { buildFrontmatterMappingsForFolder } from './property-mapping.js';

export interface PlannerOptions {
  parentPageId: string;
  /** フォルダ直下ノートのうち共通キーを持つ割合の閾値（デフォルト0.6） */
  dbSuggestionRatio?: number;
  /** database提案に必要な共通frontmatterキー数（デフォルト3） */
  dbSuggestionMinKeys?: number;
  skipList?: string[];
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
  };
}
