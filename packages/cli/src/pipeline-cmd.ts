import {
  answerQuestion,
  evalStats,
  legacyJob,
  openRuntime,
  recordRetro,
  resumeJob,
  retryFrom,
  ticketJob,
  ticketStart,
} from '@gatehouse/app';
import { raiseBudget, report } from './run-cmd.ts';

const out = (s = '') => process.stdout.write(`${s}\n`);
const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

/** Ticket → PR: PBI, spec, plan, tasks (each behind a gate), then test-first implementation. */
export async function runTicketCmd(repoName: string, flags: Record<string, string | boolean>): Promise<number> {
  const ticket = str(flags.ticket);
  if (!ticket) throw new Error('--ticket KEY is required (add --ticket-file <path> when no MCP tracker is configured)');
  const rt = openRuntime();
  try {
    const start = ticketStart(rt, { repo: repoName, ticket, ticketFile: str(flags['ticket-file']) });
    out(`Ticket ${start.ticketKey} on ${repoName}`);
    return report(await ticketJob(rt, start, out));
  } finally {
    rt.close();
  }
}

/** Legacy test coverage: rank untested classes, charter scenarios, write characterization tests. */
export async function runLegacyCmd(repoName: string, flags: Record<string, string | boolean>): Promise<number> {
  const top = str(flags.top) ? Number(flags.top) : undefined;
  if (top !== undefined && (!Number.isInteger(top) || top < 1)) throw new Error('--top must be a positive number');
  const rt = openRuntime();
  try {
    out(`Legacy tests on ${repoName}${str(flags.package) ? ` (package ${flags.package})` : ''}`);
    return report(await legacyJob(rt, { workflow: 'legacy-tests', repo: repoName, scope: str(flags.package), maxTargets: top }, out));
  } finally {
    rt.close();
  }
}

/** Answers a blocking question on a ticket run and continues it. */
export async function runAnswerCmd(runId: string, flags: Record<string, string | boolean>): Promise<number> {
  const q = str(flags.q);
  const answer = str(flags.answer);
  if (!q || !answer) throw new Error('--q Q1 --answer "..." are required');
  const rt = openRuntime();
  try {
    answerQuestion(rt, runId, q, answer);
    out(`Recorded the answer to ${q}; continuing ${runId}`);
    return report(await resumeJob(rt, runId, out));
  } finally {
    rt.close();
  }
}

/** Re-runs a run from a stage (and everything after it), optionally with feedback for the agent. */
export async function runRetryCmd(runId: string, flags: Record<string, string | boolean>): Promise<number> {
  const from = str(flags.from);
  if (!from) throw new Error('--from <stage> is required');
  const rt = openRuntime();
  try {
    raiseBudget(rt, runId, flags);
    const steps = retryFrom(rt, runId, from, str(flags.note));
    out(`Invalidated ${steps.join(', ')}`);
    return report(await resumeJob(rt, runId, out));
  } finally {
    rt.close();
  }
}

/** Records the final decision of a run as a labelled eval case (the console does this on decide). */
export function retroCmd(runId: string): number {
  const rt = openRuntime();
  try {
    const c = recordRetro(rt, runId);
    if (!c) {
      out('No final decision recorded for this run yet.');
      return 1;
    }
    out(`${c.workflow} ${c.runId}: ${c.decision}${c.published ? ', published' : ''}${c.reason ? ` (${c.reason})` : ''}`);
    out(`${c.findings.length} finding(s), ${c.usage.tokens} tokens over ${c.usage.calls} model calls`);
    out(`Saved under ${rt.paths.home}/evals/${c.workflow}/`);
    return 0;
  } finally {
    rt.close();
  }
}

export function evalStatsCmd(flags: Record<string, string | boolean>, json: boolean): number {
  const rt = openRuntime();
  try {
    const workflows = str(flags.workflow) ? [str(flags.workflow)!] : ['pr-review', 'ticket', 'legacy-tests'];
    const stats = Object.fromEntries(workflows.map((w) => [w, evalStats(rt, w)]));
    if (json) {
      out(JSON.stringify(stats, null, 2));
      return 0;
    }
    for (const [w, s] of Object.entries(stats)) {
      out(`${w}: ${s.runs} decision(s), ${s.approved} approved, ${s.rejected} rejected, ${s.findings} finding(s), avg ${s.avgTokens} tokens/run`);
      if (Object.keys(s.byVerdict).length) out(`  verdicts: ${Object.entries(s.byVerdict).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      if (Object.keys(s.byEvidence).length) out(`  evidence: ${Object.entries(s.byEvidence).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    return 0;
  } finally {
    rt.close();
  }
}
