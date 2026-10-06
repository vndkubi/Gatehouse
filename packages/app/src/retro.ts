import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewPackage } from '@gatehouse/workflows';
import type { Runtime } from './runtime.ts';

export interface EvalCase {
  runId: string;
  workflow: string;
  repo: string;
  head: string | null;
  decision: 'approve' | 'reject' | 'none';
  reason: string;
  published: boolean;
  agents: Record<string, string>;
  findings: Array<{ id: string; severity: string; category: string; evidence: string; verdict: string; posted: boolean }>;
  usage: { calls: number; tokens: number };
  incomplete: boolean;
  recordedAt: string;
}

/**
 * Retro (blueprint v1 review-retro, design flywheel [CSW]): every human gate decision becomes a
 * labelled eval case. Approvals and rejections, per-finding verdicts and the agent versions that
 * produced them are the online-eval signal for changing prompts, models or policies.
 */
export function recordRetro(rt: Runtime, runId: string): EvalCase | null {
  const events = rt.events.list(runId);
  const started = events.find((e) => e.type === 'RUN_STARTED')?.payload as { workflow?: string; repo?: string } | undefined;
  if (!started?.workflow) return null;
  const decision = events.filter((e) => e.type === 'GATE_DECISION').at(-1)?.payload as { decision: 'approve' | 'reject'; reason: string; artifact: string } | undefined;
  const pkgHash = decision?.artifact ?? (events.filter((e) => e.type === 'AWAITING_GATE').at(-1)?.payload as { artifact?: string } | undefined)?.artifact;
  let pkg: ReviewPackage | null = null;
  if (pkgHash && started.workflow === 'pr-review') pkg = JSON.parse(rt.artifacts.read(pkgHash).toString('utf8')) as ReviewPackage;
  const published = events.some((e) => e.type === 'PUBLISHED');
  const postable = (v: string) => v === 'STANDS' || v === 'UNCHALLENGED';
  const usage = events.filter((e) => e.type === 'RUN_USAGE').at(-1)?.payload as { calls: number; promptTokens: number; completionTokens: number } | undefined;
  const c: EvalCase = {
    runId,
    workflow: started.workflow,
    repo: started.repo ?? '',
    head: pkg?.head ?? null,
    decision: decision?.decision ?? 'none',
    reason: decision?.reason ?? '',
    published,
    agents: pkg?.agents ?? {},
    findings: (pkg?.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, category: f.category, evidence: f.evidence, verdict: f.verdict, posted: published && postable(f.verdict) })),
    usage: { calls: usage?.calls ?? 0, tokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0) },
    incomplete: pkg?.incomplete ?? false,
    recordedAt: new Date().toISOString(),
  };
  const dir = join(rt.paths.home, 'evals', c.workflow);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), `${JSON.stringify(c, null, 2)}\n`);
  const lesson = `- ${c.recordedAt.slice(0, 10)} ${runId}: ${c.decision}${c.reason ? ` — "${c.reason.replace(/\s+/g, ' ').slice(0, 200)}"` : ''}; ${c.findings.length} finding(s), ${c.findings.filter((f) => f.posted).length} posted\n`;
  appendFileSync(join(rt.paths.home, 'evals', 'lessons.md'), lesson);
  rt.events.append(runId, 'RETRO_RECORDED', { decision: c.decision, findings: c.findings.length });
  return c;
}

export interface EvalStats {
  runs: number;
  approved: number;
  rejected: number;
  findings: number;
  byVerdict: Record<string, number>;
  byEvidence: Record<string, number>;
  avgTokens: number;
  agentVersions: Record<string, string[]>;
}

export function evalStats(rt: Runtime, workflow = 'pr-review'): EvalStats {
  const dir = join(rt.paths.home, 'evals', workflow);
  const cases: EvalCase[] = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase) : [];
  const tally = (key: 'verdict' | 'evidence') => cases.flatMap((c) => c.findings).reduce<Record<string, number>>((m, f) => ((m[f[key]] = (m[f[key]] ?? 0) + 1), m), {});
  const versions: Record<string, Set<string>> = {};
  for (const c of cases) for (const [a, v] of Object.entries(c.agents)) (versions[a] ??= new Set()).add(v);
  return {
    runs: cases.length,
    approved: cases.filter((c) => c.decision === 'approve').length,
    rejected: cases.filter((c) => c.decision === 'reject').length,
    findings: cases.reduce((n, c) => n + c.findings.length, 0),
    byVerdict: tally('verdict'),
    byEvidence: tally('evidence'),
    avgTokens: cases.length ? Math.round(cases.reduce((n, c) => n + c.usage.tokens, 0) / cases.length) : 0,
    agentVersions: Object.fromEntries(Object.entries(versions).map(([a, s]) => [a, [...s]])),
  };
}
