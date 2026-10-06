import type { ArtifactStore, StoredEvent } from '@gatehouse/core';
import { escapeHtml as esc, loadWorkflow, postable, type Finding, type ReviewPackage } from '@gatehouse/workflows';
import type { RunInfo } from './views.ts';

/**
 * Plain-language layer of the console. Internals (GATE_5, L2, T/V units, step ids) stay in the
 * data; people see what is happening, what it means and what they can do next.
 */

// ---- vocabulary -----------------------------------------------------------------------------------

export const WORKFLOW_NAME: Record<string, string> = {
  'pr-review': 'Pull request review',
  ticket: 'Ticket to pull request',
  'legacy-tests': 'Tests for legacy code',
  'env-onboarding': 'Build & test check',
};

const STEP_LABEL: Record<string, string> = {
  freeze: 'Fetch the pull request',
  enumerate: 'Split the change into blocks',
  mask: 'Hide repo instructions from agents',
  'blast-radius': 'Find code affected by the change',
  intake: 'Read the description and ticket',
  'quarantine-read': 'Extract the requirements',
  plan: 'Plan the review',
  review: 'Review the code',
  citations: 'Check every quoted line',
  evidence: 'Prove findings with tests',
  challenge: 'Second opinion (independent model)',
  synthesis: 'Write the report',
  gate: 'Wait for your decision',
  pbi: 'Write the backlog item',
  spec: 'Write the specification',
  'plan-step': 'Plan the implementation',
  tasks: 'Break it into tasks',
  'review-artifacts': 'Independent check of the plan',
  implement: 'Write tests, then code',
  'code-review': 'Review the change',
  package: 'Prepare the branch',
  inventory: 'Measure test coverage',
  triage: 'Pick the riskiest classes',
  charter: 'Design test scenarios',
  'implement-tests': 'Write the tests',
  'verify-coverage': 'Measure coverage again',
};

const stepLabel = (id: string, workflow: string) => (workflow === 'ticket' && id === 'plan' ? 'Plan the implementation' : STEP_LABEL[id] ?? id);

export interface GateInfo {
  title: string;
  explain: string;
  approve: string;
  reject: string;
}

const GATES: Record<string, GateInfo> = {
  'pr-review/GATE_5': { title: 'Post this review?', explain: 'Gatehouse has finished. Read the findings below. Approving posts them to the pull request as a single review comment; nothing has been posted yet.', approve: 'Approve and post to GitHub', reject: 'Reject (post nothing)' },
  'env-onboarding/GATE_ENV': { title: 'Trust this build & test setup?', explain: 'Gatehouse worked out how to build and test this repository and ran it. Approving lets later runs execute tests with it (to prove findings and to implement tickets).', approve: 'Approve this setup', reject: 'Reject' },
  'ticket/GATE_1': { title: 'Is this the right backlog item?', explain: 'The ticket was turned into acceptance criteria and test scenarios. Every criterion quotes the ticket. Approve to continue to the specification.', approve: 'Approve and continue', reject: 'Reject with feedback' },
  'ticket/GATE_2': { title: 'Approve the specification?', explain: 'What will change in the codebase, grounded in the actual code. Approve to continue to the plan.', approve: 'Approve and continue', reject: 'Reject with feedback' },
  'ticket/GATE_3': { title: 'Approve the implementation plan?', explain: 'Which files change, in which order, and how each scenario is tested. Approve to continue to the task list.', approve: 'Approve and continue', reject: 'Reject with feedback' },
  'ticket/GATE_4': { title: 'Start implementing?', explain: 'Each task is done test-first: a failing test, then the code that makes it pass. Gatehouse runs the tests itself. Approve to start writing code.', approve: 'Approve and implement', reject: 'Reject with feedback' },
  'ticket/GATE_5': { title: 'Open the draft pull request?', explain: 'The change is implemented, tested and reviewed. Approving pushes a gatehouse/ branch and opens a draft pull request.', approve: 'Approve and open draft PR', reject: 'Reject' },
  'legacy-tests/GATE_1': { title: 'Test these classes?', explain: 'The classes below were picked by risk and missing coverage. Approve to design test scenarios for them.', approve: 'Approve and continue', reject: 'Reject with feedback' },
  'legacy-tests/GATE_2': { title: 'Approve the test scenarios?', explain: 'Scenarios describe current behaviour in business terms. Approve to write the tests.', approve: 'Approve and write tests', reject: 'Reject with feedback' },
  'legacy-tests/GATE_3': { title: 'Keep the new tests?', explain: 'The new tests pass on the unchanged code; coverage was measured again. Approve to continue to the review.', approve: 'Approve and continue', reject: 'Reject with feedback' },
  'legacy-tests/GATE_4': { title: 'Open the draft pull request?', explain: 'Only test files are included. Approving pushes a gatehouse/ branch and opens a draft pull request.', approve: 'Approve and open draft PR', reject: 'Reject' },
};

export function gateInfo(workflow: string, gate: string): GateInfo {
  return GATES[`${workflow}/${gate}`] ?? { title: `Decision needed (${gate})`, explain: 'Gatehouse is waiting for your decision.', approve: 'Approve', reject: 'Reject' };
}

export interface FriendlyStatus {
  key: string;
  text: string;
  cls: 'ok' | 'warn' | 'bad' | 'run' | '';
}

/** One status a person understands, from the run's events and whether a job is working on it now. */
export function friendlyStatus(info: RunInfo, active: 'queued' | 'running' | null, hasQuestions: boolean): FriendlyStatus {
  if (active === 'queued') return { key: 'queued', text: 'Waiting to start', cls: 'run' };
  if (active === 'running') return { key: 'running', text: 'Running', cls: 'run' };
  const s = info.status;
  if (s === 'published') return { key: 'published', text: 'Posted to GitHub', cls: 'ok' };
  if (s.startsWith('awaiting')) return { key: 'gate', text: 'Needs your decision', cls: 'warn' };
  if (s === 'blocked') return hasQuestions ? { key: 'questions', text: 'Needs your answer', cls: 'warn' } : { key: 'blocked', text: 'Blocked', cls: 'bad' };
  if (s === 'denied by policy') return { key: 'denied', text: 'Not allowed by policy', cls: 'bad' };
  if (s.startsWith('rejected')) return { key: 'rejected', text: 'Rejected by you', cls: '' };
  if (s === 'done') return { key: 'done', text: 'Finished', cls: 'ok' };
  if (s === 'approved') return { key: 'approved', text: 'Approved', cls: 'ok' };
  if (s === 'superseded') return { key: 'superseded', text: 'Replaced by a newer check', cls: '' };
  if (s === 'failed') return { key: 'failed', text: 'Stopped with an error', cls: 'bad' };
  return { key: 'interrupted', text: 'Interrupted', cls: 'bad' };
}

export function ago(ts: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (!ts || Number.isNaN(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export const duration = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min` : ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.max(0, Math.round(ms / 1000))} s`);
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export const badge = (st: FriendlyStatus) => `<span class="badge ${st.cls}">${st.cls === 'run' ? '<span class="spin"></span>' : ''}${esc(st.text)}</span>`;

// ---- progress -------------------------------------------------------------------------------------

export interface Progress {
  steps: Array<{ id: string; label: string; state: 'done' | 'running' | 'failed' | 'pending' | 'waiting'; ms?: number; detail?: string }>;
  done: number;
  total: number;
  pct: number;
  current: string | null;
  elapsedMs: number;
  tokens: number;
}

export function progressOf(events: StoredEvent[], workflow: string, now = Date.now()): Progress {
  const p = (e: StoredEvent) => (e.payload ?? {}) as Record<string, any>;
  const startedAt = events[0] ? Date.parse(events[0].ts) : now;
  const lastResume = Math.max(0, events.map((e) => e.type).lastIndexOf('RUN_RESUMED'));
  const tokensUsed = events.filter((e) => e.type === 'MODEL_CALL').reduce((t, e) => t + (p(e).promptTokens ?? 0) + (p(e).completionTokens ?? 0), 0);
  let steps: Progress['steps'];
  if (workflow === 'env-onboarding') {
    const has = (t: string) => events.some((e) => e.type === t);
    const verify = events.filter((e) => e.type === 'VERIFY_STEP').map((e) => p(e));
    const cell = (p(events.find((e) => e.type === 'RUN_STARTED') ?? events[0]!).target ?? 'host') === 'cell';
    steps = [
      { id: 'detect', label: 'Read build files and CI', state: has('ENV_DETECTED') ? 'done' : 'running' },
      { id: 'workspace', label: 'Prepare a clean copy', state: has('WORKSPACE_PREPARED') ? 'done' : has('ENV_DETECTED') ? 'running' : 'pending' },
      ...(cell ? [{ id: 'warm', label: 'Download dependencies (once)', state: has('CELL_WARMED') ? 'done' : has('WORKSPACE_PREPARED') ? 'running' : 'pending' } as Progress['steps'][number]] : []),
      ...verify.map((v) => ({ id: String(v.name), label: v.name === 'build' ? 'Build' : v.name === 'testAll' ? 'Run all tests' : v.name === 'testOne' ? 'Run a single test' : String(v.name), state: (v.code === 0 && !v.timedOut ? 'done' : 'failed') as 'done' | 'failed', ms: v.durationMs })),
      { id: 'verdict', label: 'Wait for your decision', state: has('AWAITING_GATE') ? (events.some((e) => e.type === 'GATE_DECISION') ? 'done' : 'waiting') : 'pending' },
    ];
  } else {
    let def: ReturnType<typeof loadWorkflow> | null = null;
    try {
      def = loadWorkflow(workflow);
    } catch {
      def = null;
    }
    const ids = def ? def.steps.map((s) => s.id) : [];
    const state = new Map<string, Progress['steps'][number]>();
    for (const id of ids) state.set(id, { id, label: stepLabel(id, workflow), state: 'pending' });
    for (const [i, e] of events.entries()) {
      const id = String(p(e).stepId ?? '');
      if (e.type === 'STEP_STARTED' && state.has(id)) state.set(id, { ...state.get(id)!, state: 'running' });
      if (e.type === 'STEP_DONE' && state.has(id)) state.set(id, { ...state.get(id)!, state: 'done', ms: p(e).durationMs });
      if (e.type === 'STEP_FAILED' && state.has(id)) state.set(id, { ...state.get(id)!, state: i >= lastResume ? 'failed' : 'pending', detail: String(p(e).error ?? '').slice(0, 200) });
      if (e.type === 'STEP_INVALIDATED') for (const s of (p(e).stepIds ?? []) as string[]) if (state.has(s)) state.set(s, { ...state.get(s)!, state: 'pending' });
    }
    // A gate step is "done" in the engine once it asked; for people it is waiting until decided.
    const decided = new Set(events.filter((e) => e.type === 'GATE_DECISION').map((e) => String(p(e).gate)));
    const asked = new Set(events.filter((e) => e.type === 'AWAITING_GATE').map((e) => String(p(e).gate)));
    for (const s of def?.steps ?? []) {
      if (s.kind !== 'gate' || !s.gate) continue;
      const st = state.get(s.id)!;
      if (asked.has(s.gate) && !decided.has(s.gate)) state.set(s.id, { ...st, label: 'Wait for your decision', state: 'waiting' });
      else if (decided.has(s.gate)) state.set(s.id, { ...st, label: 'Your decision', state: 'done' });
      else state.set(s.id, { ...st, label: 'Your decision' });
    }
    // Unit-level detail for the long review step.
    const units = events.filter((e) => e.type === 'AGENT_RUN' && String(p(e).step).startsWith('review-')).length;
    if (state.get('review')?.state === 'running' && units) state.set('review', { ...state.get('review')!, detail: `${units} review unit run(s) finished so far` });
    steps = [...state.values()];
  }
  const work = steps;
  const done = work.filter((s) => s.state === 'done').length;
  const current = steps.find((s) => s.state === 'running')?.label ?? steps.find((s) => s.state === 'waiting')?.label ?? null;
  const last = events.at(-1);
  return { steps, done, total: work.length, pct: work.length ? Math.round((done / work.length) * 100) : 0, current, elapsedMs: (last ? Date.parse(last.ts) : now) - startedAt, tokens: tokensUsed };
}

export function renderProgress(pr: Progress, live: boolean): string {
  const icon = { done: '✓', running: '<span class="spin"></span>', failed: '✕', pending: '', waiting: '●' } as const;
  return `<div class="progress"><div class="pbar"><span style="width:${pr.pct}%"></span></div>
<p class="muted small">${pr.done} of ${pr.total} steps · ${duration(pr.elapsedMs)}${pr.tokens ? ` · ${tokens(pr.tokens)} tokens` : ''}${live && pr.current ? ` · now: <strong>${esc(pr.current)}</strong>` : ''}</p>
<ol class="steps">${pr.steps.map((s) => `<li class="${s.state}"><span class="dot">${icon[s.state]}</span><span>${esc(s.label)}${s.detail ? `<span class="muted small"> — ${esc(s.detail)}</span>` : ''}</span><span class="muted small">${s.ms !== undefined && s.state === 'done' ? duration(s.ms) : ''}</span></li>`).join('')}</ol></div>`;
}

// ---- findings ---------------------------------------------------------------------------------------

const SEVERITY: Record<string, { label: string; cls: string }> = {
  P1: { label: 'Critical', cls: 'p1' },
  P2: { label: 'High', cls: 'p2' },
  P3: { label: 'Medium', cls: 'p3' },
  P4: { label: 'Low', cls: 'p4' },
};

const EVIDENCE: Record<string, { text: string; cls: string }> = {
  REPRO_RED: { text: 'Proven: a test fails with this change and passes without it', cls: 'ok' },
  REPRO_RED_BOTH: { text: 'The test also fails without this change (may be pre-existing)', cls: 'warn' },
  REPRO_GREEN: { text: 'The test passed: not proven', cls: 'warn' },
  REPRO_INCONCLUSIVE: { text: 'A proof test was written but could not run', cls: '' },
  CITED: { text: 'Quoted code verified (not proven by a test)', cls: '' },
  NO_EVIDENCE: { text: 'The quoted code does not exist: rejected', cls: 'bad' },
};

const VERDICT: Record<string, string> = {
  STANDS: 'Second reviewer agrees',
  UNCHALLENGED: 'Not challenged (only critical/high findings get a second opinion)',
  DISPUTED: 'Second reviewer disagrees: you decide',
  WITHDRAWN: 'Withdrawn after the second opinion',
  REJECTED: 'Rejected: will not be posted',
};

function codeLink(pkg: ReviewPackage, f: Finding): string {
  const loc = `${f.file}:${f.line}`;
  if (!pkg.pr) return `<code>${esc(loc)}</code>`;
  return `<a href="https://github.com/${esc(pkg.pr.owner)}/${esc(pkg.pr.repo)}/blob/${esc(pkg.head)}/${esc(f.file)}#L${f.line}" rel="noreferrer" target="_blank"><code>${esc(loc)}</code></a>`;
}

export function renderFindings(pkg: ReviewPackage): string {
  const order = (f: Finding) => (postable(f) ? 0 : f.verdict === 'DISPUTED' ? 1 : 2) * 10 + Number(f.severity.slice(1));
  const findings = [...pkg.findings].sort((a, b) => order(a) - order(b));
  const posted = findings.filter(postable);
  const count = (sev: string) => posted.filter((f) => f.severity === sev).length;
  const coverage = pkg.ledger.totalHunks ? Math.round((pkg.ledger.reviewedHunks / pkg.ledger.totalHunks) * 100) : 100;
  const notices: string[] = [];
  if (pkg.incomplete) notices.push(`<div class="notice bad"><strong>Not everything was reviewed.</strong> ${esc(pkg.incompleteReasons.slice(0, 4).join('; '))}. Retry the “Review the code” step (Activity tab) with a larger token budget before approving.</div>`);
  for (const w of pkg.warnings) {
    const text = /not approved at GATE_ENV/.test(w) ? 'Findings were checked against the code but not proven with tests, because this repository’s build & test setup has not been approved yet (Repositories page).' : w;
    notices.push(`<div class="notice">${esc(text)}</div>`);
  }
  const chips = ['P1', 'P2', 'P3', 'P4']
    .filter((s) => count(s))
    .map((s) => `<button type="button" class="chip ${SEVERITY[s]!.cls}" data-filter="${s}" aria-pressed="true">${SEVERITY[s]!.label} <b>${count(s)}</b></button>`)
    .join('');
  const hidden = findings.length - posted.length;
  const cards = findings
    .map((f) => {
      const sev = SEVERITY[f.severity] ?? { label: f.severity, cls: '' };
      const ev = EVIDENCE[f.evidence] ?? { text: f.evidence, cls: '' };
      const will = postable(f);
      return `<article class="finding ${will ? '' : 'dim'}" data-sev="${esc(f.severity)}" data-posted="${will}">
<header><span class="sev ${sev.cls}">${sev.label}</span><h3>${esc(f.title)}</h3></header>
<p class="loc">${codeLink(pkg, f)} · ${esc(f.category)}${will ? '' : ' · <strong>not posted</strong>'}</p>
<p>${esc(f.explanation)}</p>
<details><summary>How it fails and how to fix it</summary><p><strong>Scenario:</strong> ${esc(f.failing_scenario)}</p><p><strong>Suggested fix:</strong> ${esc(f.suggested_fix)}</p>${f.evidence_quote ? `<pre>${esc(f.evidence_quote)}</pre>` : ''}${f.notes.length ? `<p class="muted small">${esc(f.notes.join(' · '))}</p>` : ''}</details>
<footer><span class="ev ${ev.cls}">${esc(ev.text)}</span><span class="muted small">${esc(VERDICT[f.verdict] ?? f.verdict)}</span></footer></article>`;
    })
    .join('');
  return `<div class="summary-line"><div><span class="big">${posted.length}</span> finding${posted.length === 1 ? '' : 's'} to post</div><div><span class="big">${coverage}%</span> of the change reviewed (${pkg.ledger.reviewedHunks}/${pkg.ledger.totalHunks} blocks)</div><div><span class="big">${pkg.units.length}</span> review passes</div></div>
${notices.join('')}
${findings.length ? `<div class="filters">${chips}${hidden ? `<label class="inline"><input type="checkbox" id="show-dim"> show ${hidden} not posted</label>` : ''}</div><div class="findings">${cards}</div>` : '<p class="empty">No problems found.</p>'}`;
}

/** The review package a pr-review run asked approval for (latest GATE_5 artifact). */
export function reviewPackageOf(events: StoredEvent[], artifacts: ArtifactStore): ReviewPackage | null {
  const gate = events.filter((e) => e.type === 'AWAITING_GATE').at(-1)?.payload as { artifact?: string } | undefined;
  if (!gate?.artifact) return null;
  try {
    const legacy = { acStatus: [], orphans: [], incomplete: false, incompleteReasons: [], warnings: [], masked: [], unreviewable: [], units: [], blast: { symbols: 0, dependentFiles: [], testsAtRisk: [] } };
    return { ...legacy, ...(JSON.parse(artifacts.read(gate.artifact).toString('utf8')) as ReviewPackage) };
  } catch {
    return null;
  }
}

// ---- environment ------------------------------------------------------------------------------------

export function envText(env: { level: string; approved: boolean; target: 'host' | 'cell'; baseline: { summary: { total: number; passed: number; failed: number; skipped: number } } | null }, checking: boolean): { text: string; cls: string; hint: string } {
  const where = env.target === 'cell' ? 'in a sandbox container' : 'on this computer';
  if (checking) return { text: 'Checking now…', cls: 'run', hint: '' };
  if (env.level === 'L0') return { text: 'Not checked yet', cls: '', hint: 'Check it once so Gatehouse can run tests (proves findings, needed for tickets and legacy tests).' };
  const tests = env.baseline ? `${env.baseline.summary.passed} of ${env.baseline.summary.total} tests pass` : '';
  const what = env.level === 'L2' ? `Builds; ${tests}` : 'Builds; tests not runnable';
  return env.approved
    ? { text: `${what} · approved`, cls: 'ok', hint: `Tests run ${where}.` }
    : { text: `${what} · waiting for your approval`, cls: 'warn', hint: `Checked ${where}. Approve it to let Gatehouse run tests.` };
}

export const PCI_TEXT: Record<string, string> = { out: 'Not in PCI scope', connected: 'PCI connected', cde: 'PCI cardholder data' };
