import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanVault } from '../scanner.js';
import { buildPlan, suggestFolderModes } from '../planner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(__dirname, '../../../../fixtures/test-vault');

describe('planner DB化自動提案', () => {
  it('直下ノートの60%以上が共通frontmatterキーを3つ持つフォルダにdatabaseを提案する', async () => {
    const inv = await scanVault(VAULT);
    const folders = suggestFolderModes(inv, { parentPageId: 'root' });
    const dbFolder = folders.find((f) => f.folderPath === 'DatabaseFolder');
    expect(dbFolder?.mode).toBe('database');
  });

  it('共通キーが3未満のフォルダはpage_treeのまま', async () => {
    const inv = await scanVault(VAULT);
    const folders = suggestFolderModes(inv, { parentPageId: 'root' });
    const folder1 = folders.find((f) => f.folderPath === 'Folder1');
    expect(folder1?.mode).toBe('page_tree');
  });

  it('buildPlanはdatabaseフォルダのfrontmatterMappingsを生成する', async () => {
    const inv = await scanVault(VAULT);
    const plan = buildPlan(inv, { parentPageId: 'root' });
    const mappings = plan.frontmatterMappings['DatabaseFolder'];
    expect(mappings?.some((m) => m.key === 'status')).toBe(true);
    expect(mappings?.some((m) => m.key === 'priority' && m.notionPropertyType === 'number')).toBe(true);
    expect(mappings?.some((m) => m.key === 'due' && m.notionPropertyType === 'date')).toBe(true);
  });
});
