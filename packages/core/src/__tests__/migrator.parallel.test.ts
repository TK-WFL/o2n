import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forEachNote, runMigration, wasAborted } from '../migrator.js';
import { createMockServer, setupMigration } from './helpers/mock-notion.js';

describe('forEachNote（#144）', () => {
  it('同時実行数を守り、全件に onSettled を呼ぶ', async () => {
    let inFlight = 0;
    let peak = 0;
    const settled: number[] = [];
    await forEachNote([...Array(10).keys()], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    }, (i) => settled.push(i));
    expect(peak).toBe(3);
    expect(settled.sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
  });

  it('例外が起きたら新しい項目を投入せず、最初の例外を投げる', async () => {
    const started: number[] = [];
    await expect(forEachNote([...Array(20).keys()], 2, async (i) => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 2));
      if (i === 3) throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(started.length).toBeLessThan(8);
  });
});

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-parallel-')));
  await fs.writeFile(path.join(tmpDir, 'shared.png'), Buffer.from([0x89]));
  for (let i = 0; i < 12; i += 1) {
    const n = String(i).padStart(2, '0');
    await fs.writeFile(path.join(tmpDir, `N${n}.md`), `# N${n}\n\n[[N${String((i + 1) % 12).padStart(2, '0')}]]\n\n![[shared.png]]\n`);
  }
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 応答にランダムな遅延を入れ、同時に処理中のリクエスト数の最大値を記録する */
function withLatency(mock: ReturnType<typeof createMockServer>) {
  let inFlight = 0;
  const stats = { peak: 0 };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    inFlight += 1;
    stats.peak = Math.max(stats.peak, inFlight);
    await new Promise((r) => setTimeout(r, 2 + Math.random() * 8));
    try {
      return await mock.fetchImpl(url, init);
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return { fetchImpl, stats };
}

describe('並列移行（#144）', () => {
  it('並列でもページ作成はノート順、全ノート done、共有添付のアップロードは 1 回、リクエストが重なる', async () => {
    const mock = createMockServer();
    const { fetchImpl, stats } = withLatency(mock);
    const { inventory, plan, api, state } = await setupMigration(tmpDir, fetchImpl);
    await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false, concurrency: 4 });

    const created = mock.calls
      .filter((c) => c.method === 'POST' && c.path === '/pages')
      .map((c) => /# (N\d\d)/.exec(String((c.body as { markdown?: string }).markdown))?.[1]);
    expect(created).toEqual([...Array(12).keys()].map((i) => `N${String(i).padStart(2, '0')}`));
    for (let i = 0; i < 12; i += 1) expect(state.getNote(`N${String(i).padStart(2, '0')}.md`)?.status).toBe('done');
    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/file_uploads')).toHaveLength(1);
    expect(stats.peak).toBeGreaterThan(1);
  });

  it('逐次（既定）と並列で state の結果が同じ', async () => {
    const run = async (concurrency?: number) => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-par-cmp-')));
      await fs.cp(tmpDir, dir, { recursive: true });
      const mock = createMockServer();
      const { inventory, plan, api, state } = await setupMigration(dir, withLatency(mock).fetchImpl);
      await runMigration({ vaultPath: dir, plan, inventory, api, state, dryRun: false, concurrency });
      const summary = Object.fromEntries(Object.entries(state.snapshot.notes).map(([p, n]) => [p, [n.status, n.attachedPlaceholders?.length]]));
      await fs.rm(dir, { recursive: true, force: true });
      return summary;
    };
    expect(await run(4)).toEqual(await run());
  });

  it('ブロック上限では並列でも中断し、以降のノートを処理しない', async () => {
    const mock = createMockServer();
    mock.setBlockLimitAfterCreates(3);
    const { inventory, plan, api, state } = await setupMigration(tmpDir, withLatency(mock).fetchImpl);
    const report = await runMigration({ vaultPath: tmpDir, plan, inventory, api, state, dryRun: false, concurrency: 4 });
    expect(wasAborted(report)).toBe(true);
    expect(mock.calls.filter((c) => c.method === 'POST' && c.path === '/pages').length).toBeLessThanOrEqual(3 + 4);
    expect(Object.values(state.snapshot.notes).some((n) => n.status === 'failed')).toBe(false);
  });
});
