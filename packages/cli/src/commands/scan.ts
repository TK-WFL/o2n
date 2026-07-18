import { scanVault } from '@o2n/core';

export async function scanCommand(vaultPath: string, opts: { verbose?: boolean }): Promise<void> {
  const inventory = await scanVault(vaultPath);

  console.log(`vault: ${inventory.vaultPath}`);
  console.log(`ノート数: ${inventory.notes.length}`);
  console.log(`添付ファイル数: ${inventory.attachments.length}`);
  console.log(`wikilink数: ${inventory.wikiLinks.length}`);
  console.log(`スキップ予定: ${inventory.skipped.length}`);
  console.log(`警告: ${inventory.warnings.length}`);

  console.log('\nフォルダツリー:');
  for (const [folder, notes] of Object.entries(inventory.folderTree).sort()) {
    console.log(`  ${folder || '(root)'}: ${notes.length}件`);
  }

  console.log('\nfrontmatterキー出現回数:');
  for (const [key, count] of Object.entries(inventory.frontmatterKeyStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`);
  }

  if (opts.verbose) {
    if (inventory.skipped.length > 0) {
      console.log('\nスキップ予定ファイル:');
      for (const s of inventory.skipped) console.log(`  - ${s.path}: ${s.reason}`);
    }
    if (inventory.warnings.length > 0) {
      console.log('\n警告:');
      for (const w of inventory.warnings) {
        console.log(`  - ${w.sourcePath}: "${w.linkText}" (${w.reason})`);
      }
    }
  }
}
