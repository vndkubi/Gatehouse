import { randomUUID } from 'node:crypto';
import type { JobOutcome } from './jobs.ts';

export interface QueuedJob {
  id: string;
  kind: string;
  label: string;
  /** Jobs touching the same repo's build/test resources run one at a time. */
  lockKey: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  outcome?: JobOutcome;
  log: string[];
}

/**
 * In-process job queue for the console: global concurrency limit plus a per-repo lock, so two
 * runs never fight over the same local ports, DB or ~/.m2 on the host (design 08 §2).
 */
export class JobQueue {
  private readonly jobs: QueuedJob[] = [];
  private readonly running = new Set<string>();
  private readonly locks = new Set<string>();
  private readonly work = new Map<string, (job: QueuedJob) => Promise<JobOutcome>>();

  constructor(private readonly concurrency: number) {}

  submit(kind: string, label: string, lockKey: string, fn: (job: QueuedJob) => Promise<JobOutcome>): QueuedJob {
    const job: QueuedJob = { id: randomUUID(), kind, label, lockKey, state: 'queued', queuedAt: new Date().toISOString(), log: [] };
    this.jobs.push(job);
    this.work.set(job.id, fn);
    this.pump();
    return job;
  }

  list(): QueuedJob[] {
    return [...this.jobs].reverse();
  }

  get(id: string): QueuedJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** Resolves when nothing is queued or running (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.jobs.some((j) => j.state === 'queued' || j.state === 'running')) await new Promise((r) => setTimeout(r, 25));
  }

  private pump(): void {
    for (const job of this.jobs) {
      if (this.running.size >= this.concurrency) return;
      if (job.state !== 'queued' || this.locks.has(job.lockKey)) continue;
      const fn = this.work.get(job.id)!;
      job.state = 'running';
      job.startedAt = new Date().toISOString();
      this.running.add(job.id);
      this.locks.add(job.lockKey);
      void fn(job)
        .then((outcome) => {
          job.outcome = outcome;
          job.state = outcome.status === 'failed' ? 'failed' : 'done';
        })
        .catch((err: Error) => {
          job.outcome = { runId: '', status: 'failed', message: err.message };
          job.state = 'failed';
        })
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          this.running.delete(job.id);
          this.locks.delete(job.lockKey);
          this.work.delete(job.id);
          this.pump();
        });
    }
  }
}
