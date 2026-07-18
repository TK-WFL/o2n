export type JobStatus = 'running' | 'done' | 'error';

export interface MigrationJob {
  status: JobStatus;
  done: number;
  total: number;
  currentPath: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, MigrationJob>();

export function getJob(vaultPath: string): MigrationJob | undefined {
  return jobs.get(vaultPath);
}

export function setJob(vaultPath: string, job: MigrationJob): void {
  jobs.set(vaultPath, job);
}
