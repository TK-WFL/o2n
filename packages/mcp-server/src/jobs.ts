import { atomicWriteVaultStateFile, readVaultStateFile } from '@tk_wfl/o2n-core';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface MigrationJob {
  status: JobStatus;
  done: number;
  total: number;
  currentPath: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** 同時に走らせられる移行ジョブ数（vault ごとに1つ、全体でこの数まで、#117） */
export const MAX_CONCURRENT_JOBS = 2;

const jobs = new Map<string, MigrationJob>();
const controllers = new Map<string, AbortController>();

export function getJob(vaultPath: string): MigrationJob | undefined {
  return jobs.get(vaultPath);
}

/**
 * サーバー再起動後も migration_status が直前の状態を返せるよう、.o2n/job.json にも保存する（#117）。
 * 保存に失敗しても移行自体は止めない。running のまま残っていた場合は再起動で消えた扱いにする（loadJob 参照）
 */
export function setJob(vaultPath: string, job: MigrationJob): Promise<void> {
  jobs.set(vaultPath, job);
  return atomicWriteVaultStateFile(vaultPath, 'job.json', JSON.stringify(job, null, 2)).catch(() => undefined);
}

/** メモリに無ければ job.json から読む。前回 running のまま（プロセス終了で中断）なら error として返す */
export async function loadJob(vaultPath: string): Promise<MigrationJob | undefined> {
  const inMemory = jobs.get(vaultPath);
  if (inMemory) return inMemory;
  try {
    const raw = await readVaultStateFile(vaultPath, 'job.json');
    const job = JSON.parse(raw) as MigrationJob;
    if (job.status === 'running') {
      return { ...job, status: 'error', error: 'MCP サーバーの再起動により移行プロセスが終了しました。resume_migration で続きから再開できます。', finishedAt: Date.now() };
    }
    return job;
  } catch {
    return undefined;
  }
}

export function runningJobCount(): number {
  return [...jobs.values()].filter((j) => j.status === 'running').length;
}

export function registerController(vaultPath: string): AbortController {
  const c = new AbortController();
  controllers.set(vaultPath, c);
  return c;
}

export function cancelJob(vaultPath: string): boolean {
  const c = controllers.get(vaultPath);
  if (!c || jobs.get(vaultPath)?.status !== 'running') return false;
  c.abort();
  return true;
}

export function releaseController(vaultPath: string): void {
  controllers.delete(vaultPath);
}
