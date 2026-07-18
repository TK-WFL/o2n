#!/usr/bin/env node
import { Command } from 'commander';
import { scanCommand } from './commands/scan.js';
import { planCommand } from './commands/plan.js';
import { migrateCommand } from './commands/migrate.js';
import { resumeCommand } from './commands/resume.js';
import { verifyCommand } from './commands/verify.js';
import { reportCommand } from './commands/report.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login.js';

const program = new Command();
program.name('o2n').description('Obsidian vault を Notion へ移行するツール').version('0.1.0');

program
  .command('login')
  .description('ブラウザでNotionと連携する（NOTION_TOKENの手動設定が不要になる）')
  .action(async () => {
    process.exitCode = await loginCommand();
  });

program
  .command('logout')
  .description('Notionとの連携を解除する')
  .action(async () => {
    process.exitCode = await logoutCommand();
  });

program
  .command('whoami')
  .description('現在連携中のNotionワークスペースを表示する')
  .action(async () => {
    process.exitCode = await whoamiCommand();
  });

program
  .command('scan')
  .description('vaultを走査してインベントリを表示する（読み取りのみ）')
  .argument('<vaultPath>', 'Obsidian vaultのパス')
  .option('--verbose', '詳細ログを表示')
  .action(async (vaultPath: string, opts: { verbose?: boolean }) => {
    await scanCommand(vaultPath, opts);
  });

program
  .command('plan')
  .description('移行計画を対話式に生成する')
  .argument('<vaultPath>', 'Obsidian vaultのパス')
  .option('--out <path>', '計画ファイルの出力先')
  .option('--parent <pageId>', '移行先のNotion親ページID')
  .option('--yes', 'DB化提案をすべて自動承認する')
  .action(async (vaultPath: string, opts: { out?: string; parent?: string; yes?: boolean }) => {
    await planCommand(vaultPath, opts);
  });

program
  .command('migrate')
  .description('移行を実行する')
  .argument('<vaultPath>', 'Obsidian vaultのパス')
  .requiredOption('--plan <path>', '計画ファイルのパス')
  .option('--parent <pageId>', '移行先のNotion親ページID（計画ファイルの値を上書き）')
  .option('--dry-run', '書き込みAPIを呼ばずに計画のみ出力する')
  .option('--verbose', '詳細ログを表示')
  .action(async (vaultPath: string, opts: { plan: string; parent?: string; dryRun?: boolean; verbose?: boolean }) => {
    const code = await migrateCommand(vaultPath, opts);
    process.exitCode = code;
  });

program
  .command('resume')
  .description('中断した移行を再開する')
  .argument('<vaultPath>', 'Obsidian vaultのパス')
  .option('--verbose', '詳細ログを表示')
  .action(async (vaultPath: string, opts: { verbose?: boolean }) => {
    const code = await resumeCommand(vaultPath, opts);
    process.exitCode = code;
  });

program
  .command('verify')
  .description('移行後検証（件数照合・未解決リンク数）')
  .argument('<vaultPath>', 'Obsidian vaultのパス')
  .action(async (vaultPath: string) => {
    const code = await verifyCommand(vaultPath);
    process.exitCode = code;
  });

program
  .command('report')
  .description('レポートを表示する')
  .argument('<vaultPath>', 'Obsidian vaultのパス')
  .action(async (vaultPath: string) => {
    const code = await reportCommand(vaultPath);
    process.exitCode = code;
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
