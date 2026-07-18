import { promises as fs } from 'node:fs';
import path from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import { scanVault, suggestFolderModes, buildPlan, type FolderPlan } from '@o2n/core';

export interface PlanCommandOptions {
  out?: string;
  parent?: string;
  yes?: boolean;
}

export async function planCommand(vaultPath: string, opts: PlanCommandOptions): Promise<string> {
  const inventory = await scanVault(vaultPath);

  const parentPageId =
    opts.parent ?? (await input({ message: '移行先のNotion親ページIDを入力してください:' }));

  const suggested = suggestFolderModes(inventory, { parentPageId });
  const finalFolders: FolderPlan[] = [];

  for (const folder of suggested) {
    if (folder.mode === 'database') {
      console.log(`\nフォルダ "${folder.folderPath}" はDB化を提案されています: ${folder.suggestionReason}`);
      const accept = opts.yes ? true : await confirm({ message: 'databaseモードで移行しますか？', default: true });
      finalFolders.push({ ...folder, mode: accept ? 'database' : 'page_tree' });
    } else {
      finalFolders.push(folder);
    }
  }

  const plan = buildPlan(inventory, { parentPageId });
  plan.folders = finalFolders;
  // page_treeへ変更されたフォルダのfrontmatterMappingsは不要なので除去
  for (const folder of finalFolders) {
    if (folder.mode !== 'database') delete plan.frontmatterMappings[folder.folderPath];
  }

  const outPath = opts.out ?? path.join(vaultPath, '.o2n', 'plan.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(plan, null, 2), 'utf-8');
  console.log(`\n計画を書き出しました: ${outPath}`);
  return outPath;
}
