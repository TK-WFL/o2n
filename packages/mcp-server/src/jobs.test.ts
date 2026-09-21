import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cancelJob, getJob, loadJob, registerController, releaseController, runningJobCount, setJob } from './jobs.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'o2n-jobs-')));
  await fs.mkdir(path.join(dir, '.obsidian'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('MCP ジョブ状態（#117）', () => {
  it('setJob は .o2n/job.json にも保存し、loadJob はメモリに無ければそこから読む（running は error 扱い）', async () => {
    await setJob(dir, { status: 'running', done: 3, total: 10, currentPath: 'x', startedAt: 1 });
    const raw = JSON.parse(await fs.readFile(path.join(dir, '.o2n', 'job.json'), 'utf-8')) as { done: number };
    expect(raw.done).toBe(3);
    // メモリを空にした状況を再現するため別パス経由で読む
    const other = await fs.realpath(dir);
    await setJob(other, { status: 'done', done: 10, total: 10, currentPath: '', startedAt: 1, finishedAt: 2 });
    expect((await loadJob(other))?.status).toBe('done');
  });

  it('cancelJob は running のジョブだけ中断できる', () => {
    const c = registerController(dir);
    setJob(dir, { status: 'done', done: 1, total: 1, currentPath: '', startedAt: 1 });
    expect(cancelJob(dir)).toBe(false);
    setJob(dir, { status: 'running', done: 0, total: 1, currentPath: '', startedAt: 1 });
    expect(runningJobCount()).toBeGreaterThanOrEqual(1);
    expect(cancelJob(dir)).toBe(true);
    expect(c.signal.aborted).toBe(true);
    releaseController(dir);
    expect(getJob(dir)?.status).toBe('running');
  });
});
