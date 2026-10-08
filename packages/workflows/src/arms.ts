import type { ArtifactStore, EventStore } from '@gatehouse/core';
import { similarity } from './audit.ts';
import type { Finding } from './findings.ts';
import type { ReviewPackage } from './package.ts';

/**
 * A/B/C comparison of review arms on the same PR (design 09 §5). Everything here is measured
 * from the runs' events and packages. "Relative recall" is computed against the union of
 * confirmed findings across the arms compared, which is NOT ground truth: a defect no arm
 * confirmed is invisible to it. Absolute recall needs labelled PRs (the eval plane).
 */
export interface ArmMetrics {
  runId: string;
  arm: string;
  source: string;
  head: string;
  /** Items by final status (B/C); units for A. */
  items: Record<string, number>;
  notChecked: number;
  missingContract: number;
  candidates: number;
  candidatesRejected: number;
  rootCauses: number;
  confirmed: number;
  confirmedPreexisting: number;
  withdrawn: number;
  unconfirmed: number;
  blocked: number;
  explained: number;
  /** Tests that did not run or failed by exception: the verifier's waste. */
  invalidTests: number;
  testRuns: number;
  testMs: number;
  modelCalls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  /** Tokens spent in verification (verify-*, lookup-*, fix-*), and per root cause verified. */
  verificationTokens: number;
  verificationTokensPerCause: number | null;
  /** Calls through the gateway by phase: review (audit/agentic), investigation, verification. */
  tokensByPhase: Record<string, number>;
  rateLimitWaitMs: number;
  wallMs: number;
  stepMs: Record<string, number>;
  foundByInvestigation: number;
  confirmedKeys: Array<{ file: string; line: number; title: string }>;
}

const phaseOf = (step: string): string =>
  /^(audit|review)-/.test(step) ? 'review' : /^(expand|second|lookup)-/.test(step) ? 'investigation' : /^(verify|fix)-/.test(step) ? 'verification' : /^quarantine/.test(step) ? 'intake' : 'other';

export function armMetrics(events: EventStore, artifacts: ArtifactStore, runId: string): ArmMetrics {
  const list = events.list(runId);
  const started = list.find((e) => e.type === 'RUN_STARTED');
  const synth = list.filter((e) => e.type === 'STEP_DONE' && (e.payload as { stepId: string }).stepId === 'synthesis').at(-1);
  if (!synth) throw new Error(`run ${runId} has no finished review package`);
  const pkg = JSON.parse(artifacts.read((synth.payload as { result: { packageHash: string } }).result.packageHash).toString('utf8')) as ReviewPackage;
  const calls = list.filter((e) => e.type === 'MODEL_CALL').map((e) => e.payload as { stepId: string; promptTokens: number; completionTokens: number; cachedPromptTokens?: number });
  const tokensByPhase: Record<string, number> = {};
  for (const c of calls) tokensByPhase[phaseOf(c.stepId)] = (tokensByPhase[phaseOf(c.stepId)] ?? 0) + c.promptTokens + c.completionTokens;
  const stepMs: Record<string, number> = {};
  for (const e of list.filter((x) => x.type === 'STEP_DONE')) {
    const p = e.payload as { stepId: string; durationMs: number };
    stepMs[p.stepId] = (stepMs[p.stepId] ?? 0) + p.durationMs;
  }
  const repro = list.filter((e) => e.type === 'REPRO_RUN').map((e) => e.payload as { evidence: string; headMs: number });
  const by = (s: string) => pkg.findings.filter((f) => f.status === s).length;
  const a = pkg.audit;
  const items: Record<string, number> = a ? Object.fromEntries(Object.entries(a.counts).map(([k, v]) => [k, v ?? 0])) : {};
  const verifiedCauses = (a?.verifications ?? []).filter((v) => v.status !== 'explained' && v.status !== 'blocked' && v.status !== 'not-verified').length;
  const verificationTokens = tokensByPhase.verification ?? 0;
  const confirmed = pkg.findings.filter((f) => f.status === 'confirmed' || f.status === 'confirmed-preexisting');
  const firstTs = Date.parse(started?.ts ?? list[0]?.ts ?? '');
  const lastTs = Date.parse(synth.ts);
  return {
    runId,
    arm: a?.arm ?? 'pr-review',
    source: pkg.source.label,
    head: pkg.head,
    items,
    notChecked: (items.cannot_determine ?? 0) + (items.unresolved ?? 0) + (items.not_run ?? 0),
    missingContract: (a?.items ?? []).filter((i) => i.missing.some((m) => /^\((contract|owner)\)/.test(m)) && i.status !== 'pass' && i.status !== 'fail').length,
    candidates: a?.candidates.total ?? pkg.findings.length,
    candidatesRejected: a?.candidates.citationRejected ?? pkg.findings.filter((f) => f.verdict === 'REJECTED').length,
    rootCauses: a?.candidates.groups ?? pkg.findings.filter((f) => f.verdict !== 'REJECTED').length,
    confirmed: by('confirmed'),
    confirmedPreexisting: by('confirmed-preexisting'),
    withdrawn: by('withdrawn'),
    unconfirmed: by('unconfirmed'),
    blocked: by('blocked'),
    explained: by('explained'),
    invalidTests: (a?.verifications ?? []).filter((v) => v.status === 'unconfirmed').length,
    testRuns: repro.length,
    testMs: repro.reduce((n, r) => n + r.headMs, 0),
    modelCalls: calls.length,
    promptTokens: calls.reduce((n, c) => n + c.promptTokens, 0),
    cachedPromptTokens: calls.reduce((n, c) => n + (c.cachedPromptTokens ?? 0), 0),
    completionTokens: calls.reduce((n, c) => n + c.completionTokens, 0),
    verificationTokens,
    verificationTokensPerCause: verifiedCauses ? Math.round(verificationTokens / verifiedCauses) : null,
    tokensByPhase,
    rateLimitWaitMs: list.filter((e) => e.type === 'RATE_LIMIT_WAIT').reduce((n, e) => n + (e.payload as { waitedMs: number }).waitedMs, 0),
    wallMs: Number.isFinite(firstTs) && Number.isFinite(lastTs) ? lastTs - firstTs : Object.values(stepMs).reduce((x, y) => x + y, 0),
    stepMs,
    foundByInvestigation: (a?.investigations ?? []).filter((v) => v.after === 'fail' && v.before !== 'fail').length,
    confirmedKeys: confirmed.map((f: Finding) => ({ file: f.file, line: f.line, title: f.title })),
  };
}

/** Same defect across arms: same file, within 10 lines or a similar title. Approximate by design. */
function sameDefect(x: { file: string; line: number; title: string }, y: { file: string; line: number; title: string }): boolean {
  return x.file === y.file && (Math.abs(x.line - y.line) <= 10 || similarity(x.title, y.title) >= 0.3);
}

export interface ArmComparison {
  arms: ArmMetrics[];
  unionConfirmed: number;
  relativeRecall: Record<string, number | null>;
}

export function compareArms(arms: ArmMetrics[]): ArmComparison {
  const union: Array<{ file: string; line: number; title: string }> = [];
  for (const m of arms) for (const k of m.confirmedKeys) if (!union.some((u) => sameDefect(u, k))) union.push(k);
  const relativeRecall: Record<string, number | null> = {};
  for (const m of arms) relativeRecall[m.runId] = union.length ? union.filter((u) => m.confirmedKeys.some((k) => sameDefect(u, k))).length / union.length : null;
  return { arms, unionConfirmed: union.length, relativeRecall };
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));

export function renderComparison(c: ArmComparison): string {
  const cols = c.arms;
  const row = (label: string, f: (m: ArmMetrics) => string) => `| ${label} | ${cols.map(f).join(' | ')} |`;
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
  return [
    `# Review arms on ${cols[0]?.source ?? '?'} @ ${cols[0]?.head.slice(0, 10) ?? '?'}`,
    '',
    'Measured from run events and review packages. Relative recall is against the union of confirmed findings of these arms only; it is not true recall.',
    '',
    `| | ${cols.map((m) => `${m.arm} (\`${m.runId}\`)`).join(' | ')} |`,
    `|---|${cols.map(() => '---').join('|')}|`,
    row('Candidates (raw)', (m) => fmt(m.candidates)),
    row('… citation did not match code', (m) => fmt(m.candidatesRejected)),
    row('Root causes after grouping', (m) => fmt(m.rootCauses)),
    row('Confirmed (assertion fails on head)', (m) => fmt(m.confirmed)),
    row('Confirmed, pre-existing', (m) => fmt(m.confirmedPreexisting)),
    row('Withdrawn (test passes on head)', (m) => fmt(m.withdrawn)),
    row('Unconfirmed (test did not run / exception)', (m) => fmt(m.unconfirmed)),
    row('Blocked (no source, no env, no test)', (m) => fmt(m.blocked)),
    row('Convention, explained', (m) => fmt(m.explained)),
    row('Relative confirmed recall', (m) => pct(c.relativeRecall[m.runId])),
    row('Items not checked (context missing / unresolved)', (m) => fmt(m.notChecked)),
    row('… of which a contract/owner was missing', (m) => fmt(m.missingContract)),
    row('New problems found by investigation', (m) => fmt(m.foundByInvestigation)),
    row('Model calls (gateway)', (m) => fmt(m.modelCalls)),
    row('Prompt tokens', (m) => fmt(m.promptTokens)),
    row('… served from provider cache', (m) => `${fmt(m.cachedPromptTokens)}${m.promptTokens ? ` (${pct(m.cachedPromptTokens / m.promptTokens)})` : ''}`),
    row('Completion tokens', (m) => fmt(m.completionTokens)),
    row('Tokens: review / investigation / verification', (m) => ['review', 'investigation', 'verification'].map((p) => fmt(m.tokensByPhase[p] ?? 0)).join(' / ')),
    row('Verification tokens per root cause tested', (m) => fmt(m.verificationTokensPerCause)),
    row('Test runs / test time', (m) => `${m.testRuns} / ${(m.testMs / 1000).toFixed(0)}s`),
    row('Waiting on provider quota', (m) => `${(m.rateLimitWaitMs / 1000).toFixed(0)}s`),
    row('Wall clock', (m) => `${(m.wallMs / 1000).toFixed(0)}s`),
    '',
    'Not measured here: time a person spends reviewing the report, and tokens of Codex (subscription) calls, which do not pass through the gateway. Record review time per run in the eval labels.',
    '',
  ].join('\n');
}
