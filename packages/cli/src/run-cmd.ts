import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapters, openRuntime, resumeJob, reviewArmsJob, reviewJob, reviewStart, startGateway, type JobOutcome } from '@gatehouse/app';
import type { ReviewArm } from '@gatehouse/workflows';
import type { AgentTask } from '@gatehouse/harness';

const out = (s = '') => process.stdout.write(`${s}\n`);

export function report(o: JobOutcome): number {
  out('');
  out(`${o.status.toUpperCase()}: ${o.message}`);
  const r = o.result as { summaryPath?: string; htmlPath?: string } | undefined;
  if (r?.summaryPath) out(`Summary: ${r.summaryPath}`);
  if (r?.htmlPath) out(`Report:  ${r.htmlPath}`);
  if (o.status === 'awaiting-gate') out('Approve or reject in the console: gatehouse serve');
  if (o.status === 'failed') out(`Resume with: gatehouse run resume ${o.runId}`);
  return o.status === 'failed' || o.status === 'denied' ? 1 : 0;
}

export async function runPrReviewCmd(repoName: string, flags: Record<string, string | boolean>): Promise<number> {
  const rt = openRuntime();
  try {
    const start = reviewStart(rt, {
      repo: repoName,
      pr: typeof flags.pr === 'string' ? Number(flags.pr) : undefined,
      github: typeof flags.github === 'string' ? flags.github : undefined,
      critic: !flags['no-critic'],
      budgetTokens: typeof flags['budget-tokens'] === 'string' ? Number(flags['budget-tokens']) : undefined,
      arm: typeof flags.arm === 'string' ? (flags.arm.toUpperCase() as ReviewArm) : undefined,
    });
    out(`Reviewing ${start.source.kind === 'pr' ? `${start.source.owner}/${start.source.repoName}#${start.source.number}` : start.source.label}`);
    return report(await reviewJob(rt, start, out, undefined, Boolean(flags.keep)));
  } finally {
    rt.close();
  }
}

/** Same PR through review arms A/B/C, then a measured comparison (design 09 §5). */
export async function runReviewArmsCmd(repoName: string, flags: Record<string, string | boolean>): Promise<number> {
  const rt = openRuntime();
  try {
    const arms = String(typeof flags.arms === 'string' ? flags.arms : 'A,B,C')
      .split(',')
      .map((a) => a.trim().toUpperCase())
      .filter(Boolean) as ReviewArm[];
    if (!arms.length || arms.some((a) => !['A', 'B', 'C'].includes(a))) throw new Error('--arms takes a comma-separated subset of A,B,C');
    const r = await reviewArmsJob(
      rt,
      {
        repo: repoName,
        arms,
        pr: typeof flags.pr === 'string' ? Number(flags.pr) : undefined,
        github: typeof flags.github === 'string' ? flags.github : undefined,
        head: typeof flags.head === 'string' ? flags.head : undefined,
        base: typeof flags.base === 'string' ? flags.base : undefined,
        budgetTokens: typeof flags['budget-tokens'] === 'string' ? Number(flags['budget-tokens']) : undefined,
      },
      out,
    );
    for (const o of r.outcomes) out(`${o.runId}: ${o.status.toUpperCase()} ${o.message}`);
    if (r.reportPath) out(`\nComparison: ${r.reportPath}`);
    return r.outcomes.some((o) => o.status === 'failed' || o.status === 'denied') ? 1 : 0;
  } finally {
    rt.close();
  }
}

/** Branch / self review: any two refs, nothing posted (blueprint v1 branch-review, pr-self-review). */
export async function runBranchReviewCmd(repoName: string, flags: Record<string, string | boolean>): Promise<number> {
  const rt = openRuntime();
  try {
    const start = reviewStart(rt, {
      repo: repoName,
      head: typeof flags.head === 'string' ? flags.head : undefined,
      base: typeof flags.base === 'string' ? flags.base : undefined,
      title: typeof flags.title === 'string' ? flags.title : undefined,
      critic: !flags['no-critic'],
      budgetTokens: typeof flags['budget-tokens'] === 'string' ? Number(flags['budget-tokens']) : undefined,
    });
    out(`Reviewing ${start.source.kind === 'refs' ? start.source.label : ''}`);
    return report(await reviewJob(rt, start, out, undefined, Boolean(flags.keep)));
  } finally {
    rt.close();
  }
}

/** Records a larger token budget for the rest of a run (`--budget-tokens N` on resume/retry). */
export function raiseBudget(rt: ReturnType<typeof openRuntime>, runId: string, flags: Record<string, string | boolean>): void {
  if (typeof flags['budget-tokens'] !== 'string') return;
  const tokens = Number(flags['budget-tokens']);
  if (!Number.isInteger(tokens) || tokens < 10_000) throw new Error('--budget-tokens must be a whole number, at least 10000');
  rt.events.append(runId, 'BUDGET_SET', { tokens });
  out(`Token budget for the rest of this run: ${tokens.toLocaleString('en-US')}`);
}

export async function runResumeCmd(runId: string, flags: Record<string, string | boolean> = {}): Promise<number> {
  const rt = openRuntime();
  try {
    raiseBudget(rt, runId, flags);
    return report(await resumeJob(rt, runId, out));
  } finally {
    rt.close();
  }
}

export function runShowCmd(runId: string): number {
  const rt = openRuntime();
  try {
    const events = rt.events.list(runId);
    if (!events.length) throw new Error(`no run ${runId}`);
    for (const e of events) {
      const p = e.payload as Record<string, unknown> | null;
      const brief = p && typeof p === 'object' ? JSON.stringify(p).slice(0, 140) : String(p);
      out(`${String(e.seq).padStart(3)} ${e.ts.slice(11, 19)} ${e.type.padEnd(18)} ${brief}`);
    }
    out(`chain: ${JSON.stringify(rt.events.verify(runId))}`);
    return 0;
  } finally {
    rt.close();
  }
}

export function runListCmd(): number {
  const rt = openRuntime();
  try {
    for (const id of rt.events.runs().filter((r) => !r.startsWith('repo:')).sort().reverse().slice(0, 30)) {
      const list = rt.events.list(id);
      out(`${id.padEnd(64)} ${list.at(-1)?.type ?? ''}`);
    }
    return 0;
  } finally {
    rt.close();
  }
}

/** Smoke test: one quarantined task per executor (Copilot through the gateway, Codex). */
export async function agentProbeCmd(): Promise<number> {
  const rt = openRuntime();
  const runId = `probe-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const { gateway, url } = await startGateway(rt);
  try {
    const { copilot, codex } = adapters(rt, url);
    const dir = join(rt.paths.runs, runId);
    const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
    let failures = 0;
    for (const adapter of [copilot, codex]) {
      if (!adapter) continue;
      const cwd = join(dir, adapter.id, 'scratch');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'input.md'), 'Reply with answer set to the word pong.');
      const task: AgentTask = {
        runId,
        stepId: `probe-${adapter.id}`,
        instructions: 'Read input.md in the current directory and do what it says.',
        outputSchema: schema,
        scope: 'none',
        cwd,
        stateDir: join(dir, adapter.id, 'state'),
        tier: 'tier-scale',
        timeoutMs: 5 * 60_000,
      };
      const r = await adapter.run(task);
      if (!r.ok) failures++;
      out(`${adapter.id.padEnd(8)} ${r.ok ? 'ok  ' : 'FAIL'} ${(r.durationMs / 1000).toFixed(1)}s ${r.ok ? `answer=${(r.output as { answer: string }).answer}` : r.errors.join(' | ')}`);
    }
    const u = gateway.usageFor(runId);
    out(`gateway: ${u.calls} call(s), ${u.promptTokens}+${u.completionTokens} tokens`);
    return failures ? 1 : 0;
  } finally {
    await gateway.stop();
    rt.close();
  }
}
