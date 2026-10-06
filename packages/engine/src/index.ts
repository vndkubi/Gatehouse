import type { EventStore } from '@gatehouse/core';

export class StepFailed extends Error {
  constructor(readonly stepId: string, override readonly cause: Error) {
    super(`step ${stepId} failed: ${cause.message}`);
  }
}

/**
 * Event-sourced step runner. A step's result (kept small: hashes, counts, statuses) is stored
 * in its STEP_DONE event, so re-running a run skips finished steps and resumes where it
 * stopped. Control flow lives in code; agents only ever run inside a step.
 */
export class StepRunner {
  constructor(
    private readonly events: EventStore,
    readonly runId: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  completed(stepId: string): unknown | undefined {
    const list = this.events.list(this.runId);
    const done = list.filter((e) => e.type === 'STEP_DONE' && (e.payload as { stepId: string }).stepId === stepId).at(-1);
    if (!done) return undefined;
    const invalidated = list.some((e) => e.type === 'STEP_INVALIDATED' && e.seq > done.seq && (e.payload as { stepIds: string[] }).stepIds.includes(stepId));
    return invalidated ? undefined : (done.payload as { result: unknown }).result;
  }

  /** Forces these steps to run again on the next attempt (e.g. after a gate rejection or a clarification). */
  invalidate(stepIds: string[], reason: string): void {
    this.events.append(this.runId, 'STEP_INVALIDATED', { stepIds, reason });
  }

  async step<T>(stepId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.completed(stepId);
    if (previous !== undefined) {
      this.log(`  skip ${stepId} (already done)`);
      return previous as T;
    }
    const started = Date.now();
    this.events.append(this.runId, 'STEP_STARTED', { stepId });
    this.log(`  ...  ${stepId}`);
    try {
      const result = await fn();
      const durationMs = Date.now() - started;
      this.events.append(this.runId, 'STEP_DONE', { stepId, durationMs, result: result ?? null });
      this.log(`  ok   ${stepId.padEnd(16)} ${(durationMs / 1000).toFixed(1).padStart(7)}s`);
      return result;
    } catch (err) {
      const error = err as Error;
      this.events.append(this.runId, 'STEP_FAILED', { stepId, durationMs: Date.now() - started, error: error.message });
      this.log(`  FAIL ${stepId.padEnd(16)} ${error.message}`);
      throw new StepFailed(stepId, error);
    }
  }

  emit(type: string, payload: unknown): void {
    this.events.append(this.runId, type, payload);
  }
}

/** Runs `fn` over items with at most `limit` in flight, preserving input order in the result. */
export async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
