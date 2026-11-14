import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteVaultStateFile } from '@tk_wfl/o2n-core';
import { migrateCommand, progressPrinter } from './migrate.js';
import { planCommand } from './plan.js';
import { reportCommand } from './report.js';
import { scanCommand } from './scan.js';
import { verifyCommand } from './verify.js';

const ESC = '\u001b';
const BEL = '\u0007';
const CSI = '\u009b';
/** 端末に出てはいけない文字: 改行とタブ以外の C0、DEL、C1 */
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** ウィンドウタイトルを書き換えるシーケンスを含むフォルダ名 */
const EVIL_FOLDER = `${ESC}]0;pwned${BEL}folder`;
/** 色の変更と、行頭に戻って上書きする CR を含むノート名 */
const EVIL_NOTE = `bad${ESC}[31mname\rspoof.md`;

let testRoot: string;
let vaultPath: string;
let printed: string[];

function output(): string {
  return printed.join('\n');
}

beforeEach(async () => {
  testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-terminal-output-')));
  vaultPath = path.join(testRoot, 'vault');
  const homePath = path.join(testRoot, 'home');
  await fs.mkdir(homePath, { mode: 0o700 });
  vi.spyOn(os, 'homedir').mockReturnValue(homePath);
  vi.stubEnv('NOTION_TOKEN', '');

  await fs.mkdir(path.join(vaultPath, EVIL_FOLDER), { recursive: true });
  // YAML のエスケープ（\e、\x9b）で、キーに ESC と C1 の CSI を入れる
  const frontmatter = ['---', '"\\e[2Jkey": 1', '"\\x9b31mkey": 2', 'plain: 3', '---'].join('\n');
  for (const name of ['a', 'b', 'c']) {
    await fs.writeFile(
      path.join(vaultPath, EVIL_FOLDER, `${name}.md`),
      `${frontmatter}\n本文 [[twin${ESC}c]]\n`,
    );
  }
  // 同名のノートを 2 つ置き、リンク先が決まらないという警告を出させる
  for (const folder of ['p', 'q']) {
    await fs.mkdir(path.join(vaultPath, folder));
    await fs.writeFile(path.join(vaultPath, folder, `twin${ESC}c.md`), '# twin\n');
  }
  await fs.writeFile(path.join(vaultPath, EVIL_NOTE), '# x\n');
  await fs.writeFile(path.join(vaultPath, `図${ESC}[0m.canvas`), '{}');

  printed = [];
  const capture = (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('vault 由来の文字列を端末に出すときは制御文字を除く（#250）', () => {
  it('scan --verbose: フォルダ名、frontmatter キー、スキップ、警告', async () => {
    await scanCommand(vaultPath, { verbose: true });
    const out = output();
    expect(out).not.toMatch(FORBIDDEN);
    // 制御文字だけが消え、残りの文字はそのまま出る
    expect(out).toContain(']0;pwnedfolder: 3件');
    expect(out).toContain('[2Jkey: 3');
    expect(out).toContain('31mkey: 3');
    expect(out).toContain('図[0m.canvas');
    expect(out).toContain(']0;pwnedfolder/a.md: "twinc" (ambiguous)');
  });

  it('scan --json: DEL と C1 をエスケープし、値は変えない', async () => {
    await scanCommand(vaultPath, { json: true });
    const out = output();
    expect(out).not.toMatch(FORBIDDEN);
    const parsed = JSON.parse(out) as { folders: Record<string, number>; frontmatterKeyStats: Record<string, number> };
    expect(parsed.folders[EVIL_FOLDER]).toBe(3);
    expect(parsed.frontmatterKeyStats[`${CSI}31mkey`]).toBe(3);
    expect(parsed.frontmatterKeyStats[`${ESC}[2Jkey`]).toBe(3);
  });

  it('plan と migrate --dry-run --verbose: フォルダ名、提案理由、レポート項目', async () => {
    const out = path.join(testRoot, 'plan.json');
    await planCommand(vaultPath, { parent: 'parent-page', out, yes: true });
    expect(output()).toContain('はDB化を提案されています');
    expect(output()).toContain('[2Jkey');

    const code = await migrateCommand(vaultPath, { plan: out, dryRun: true, verbose: true, quiet: true });
    expect(code).toBe(0);
    expect(output()).toContain('[skipped] 図[0m.canvas');
    expect(output()).not.toMatch(FORBIDDEN);
  });

  it('migrate の進捗表示（TTY）: ノートのパス', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      progressPrinter(false)(1, 2, EVIL_NOTE);
      const written = String(write.mock.calls[0]?.[0]);
      // 行頭の \r は進捗表示そのものが出すもの。それ以外に制御文字は無い
      expect(written.startsWith('\r進捗: 1/2 (bad[31mnamespoof.md)')).toBe(true);
      expect(written.slice(1)).not.toMatch(FORBIDDEN);
    } finally {
      write.mockRestore();
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });

  it('migrate: 読めない計画ファイルのエラー文', async () => {
    const planPath = path.join(testRoot, 'broken.json');
    await fs.writeFile(planPath, `{"version": ${ESC}[2J`);
    const code = await migrateCommand(vaultPath, { plan: planPath, dryRun: true });
    expect(code).toBe(2);
    expect(output()).toContain('計画ファイルの読み込みに失敗しました');
    expect(output()).not.toMatch(FORBIDDEN);
  });

  it('report: レポート本文の改行とタブは残し、ほかの制御文字を除く', async () => {
    await atomicWriteVaultStateFile(vaultPath, 'report.md', `# レポート\n${ESC}]52;c;AAAA${BEL}\n\t項目\r上書き`);
    expect(await reportCommand(vaultPath)).toBe(0);
    expect(output()).toBe('# レポート\n]52;c;AAAA\n\t項目上書き');
  });

  it('verify: 未着手のノート、削除済みノートのパスとページ URL', async () => {
    const state = {
      version: 2,
      parentPageId: 'parent-page',
      notes: {
        [`gone${ESC}[31m.md`]: {
          status: 'done',
          pageId: 'page-1',
          pageUrl: `https://www.notion.so/x${ESC}]8;;https://example.invalid${BEL}`,
        },
      },
      files: {},
      folders: {},
    };
    await atomicWriteVaultStateFile(vaultPath, 'state.json', JSON.stringify(state));
    expect(await verifyCommand(vaultPath)).toBe(1);
    const out = output();
    expect(out).not.toMatch(FORBIDDEN);
    expect(out).toContain('  - bad[31mnamespoof.md');
    expect(out).toContain('  - gone[31m.md  https://www.notion.so/x]8;;https://example.invalid');

    printed = [];
    await verifyCommand(vaultPath, { json: true });
    expect(output()).not.toMatch(FORBIDDEN);
    expect((JSON.parse(output()) as { untracked: string[] }).untracked).toContain(EVIL_NOTE);
  });
});
