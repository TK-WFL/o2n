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

describe('推定ブロック数と Free プラン上限の事前警告（#70）', () => {
  it('非空行＋frontmatter callout＋添付＋フォルダを数える', async () => {
    const { estimateBlockCount, blockLimitWarning, FREE_PLAN_BLOCK_LIMIT } = await import('../planner.js');
    const inventory = {
      vaultPath: '/v',
      notes: [
        { path: 'A.md', frontmatter: { t: 1 }, content: '# A\n\n- x\n- y\n\n\n', sizeBytes: 1 },
        { path: 'Sub/B.md', frontmatter: {}, content: 'p', sizeBytes: 1 },
      ],
      attachments: [{ sourcePath: 'A.md', targetPath: 'i.png', raw: '![[i.png]]', extension: 'png' }],
      wikiLinks: [],
      skipped: [],
      warnings: [],
      folderTree: { '': ['A.md'], Sub: ['Sub/B.md'] },
      frontmatterKeyStats: {},
    };
    // A: 3行 + callout 1、B: 1行、添付 1、フォルダ Sub 1 = 7
    expect(estimateBlockCount(inventory)).toBe(7);
    expect(blockLimitWarning(7)).toBeNull();
    expect(blockLimitWarning(FREE_PLAN_BLOCK_LIMIT)).toBeNull();
    expect(blockLimitWarning(FREE_PLAN_BLOCK_LIMIT + 1)).toContain('1,000');
  });
});
