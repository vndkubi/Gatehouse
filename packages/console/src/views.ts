import type { ArtifactStore, EventStore, StoredEvent } from '@gatehouse/core';
import { pendingGate } from '@gatehouse/gates';
import {
  escapeHtml as esc,
  renderIssues,
  renderPbi,
  renderPlan,
  renderSpec,
  renderSummary,
  renderTasks,
  type PbiManifest,
  type Plan,
  type ReviewPackage,
  type Spec,
  type Tasks,
} from '@gatehouse/workflows';
import { markdownToHtml } from './markdown.ts';

export interface RunInfo {
  id: string;
  workflow: string;
  title: string;
  status: string;
  cls: string;
  gate: { gate: string; artifact: string } | null;
  updated: string;
}

const WORKFLOW_LABEL: Record<string, string> = { 'pr-review': 'PR review', ticket: 'Ticket → PR', 'legacy-tests': 'Legacy tests', 'env-onboarding': 'Environment' };

export function runInfo(events: EventStore, id: string): RunInfo {
  const list = events.list(id);
  const started = list.find((e) => e.type === 'RUN_STARTED')?.payload as Record<string, any> | undefined;
  const workflow = String(started?.workflow ?? 'run');
  // Runs started before `source` existed kept the PR coordinates at the top level.
  const src = (started?.source ?? (started?.number ? { kind: 'pr', ...started } : undefined)) as Record<string, any> | undefined;
  const title =
    workflow === 'pr-review'
      ? src?.kind === 'pr'
        ? `${src.owner}/${src.repoName}#${src.number}`
        : String(src?.label ?? started?.repo ?? id)
      : workflow === 'ticket'
        ? `${started?.ticketKey} on ${started?.repo}`
        : workflow === 'legacy-tests'
          ? `Legacy tests on ${started?.repo}`
          : `${started?.repo}${started?.target ? ` (${started.target})` : ''}`;
  const gate = pendingGate(events, id);
  const last = list.at(-1);
  const has = (t: string) => list.some((e) => e.type === t);
  const lastDecision = list.filter((e) => e.type === 'GATE_DECISION').at(-1)?.payload as { decision?: string; gate?: string } | undefined;
  let status = 'running';
  if (has('PUBLISHED')) status = 'published';
  else if (gate) status = `awaiting ${gate.gate}`;
  else if (has('POLICY_DENIED')) status = 'denied by policy';
  else if (lastDecision?.decision === 'reject') status = `rejected at ${lastDecision.gate}`;
  else if (has('RUN_COMPLETED')) status = 'done';
  else if (last?.type === 'STEP_FAILED') status = /blocked/.test(String((last.payload as { error?: string }).error)) ? 'blocked' : 'failed';
  else if (lastDecision?.decision === 'approve' && workflow === 'env-onboarding') status = 'approved';
  const cls = status === 'published' || status === 'done' || status === 'approved' ? 'ok' : status.startsWith('awaiting') ? 'warn' : /failed|denied|rejected|blocked/.test(status) ? 'bad' : '';
  return { id, workflow, title: `${WORKFLOW_LABEL[workflow] ?? workflow}: ${title}`, status, cls, gate, updated: last?.ts ?? '' };
}

/** What the human is approving, rendered from the artifact the gate is bound to. */
export function gateView(artifacts: ArtifactStore, workflow: string, gate: string, artifact: string): string {
  const json = <T>(h: string) => JSON.parse(artifacts.read(h).toString('utf8')) as T;
  const text = (h: string) => artifacts.read(h).toString('utf8');
  try {
    if (workflow === 'pr-review') {
      // Packages written by older versions lack the parity fields; fill them so they still render.
      const legacy = { acStatus: [], orphans: [], incomplete: false, incompleteReasons: [], warnings: [], masked: [], unreviewable: [], blast: { symbols: 0, dependentFiles: [], testsAtRisk: [] } };
      return markdownToHtml(renderSummary({ ...legacy, ...json<ReviewPackage>(artifact) }));
    }
    if (workflow === 'env-onboarding') return `<pre>${esc(text(artifact))}</pre>`;
    if (workflow === 'ticket') {
      if (gate === 'GATE_1') return markdownToHtml(renderPbi(json<PbiManifest>(artifact)));
      if (gate === 'GATE_2') return markdownToHtml(renderSpec(json<Spec>(artifact)));
      if (gate === 'GATE_3') return markdownToHtml(renderPlan(json<Plan>(artifact)));
      if (gate === 'GATE_4') {
        const b = json<{ tasks: string; issues: Parameters<typeof renderIssues>[0]; traceability: string }>(artifact);
        return markdownToHtml(`${renderTasks(json<Tasks>(b.tasks))}\n${renderIssues(b.issues)}\n${b.traceability}`);
      }
      if (gate === 'GATE_5') {
        const p = json<{ artifacts: Record<string, string> }>(artifact);
        return markdownToHtml(p.artifacts.summary ? text(p.artifacts.summary) : '');
      }
    }
    if (workflow === 'legacy-tests') {
      if (gate === 'GATE_1') {
        const t = json<{ backlog: Array<{ class_name: string; reason: string; priority: string; risk: string }> }>(artifact);
        return markdownToHtml(['# Proposed targets', ...t.backlog.map((b) => `- **${b.class_name}** (${b.priority}) ${b.reason} — risk: ${b.risk}`)].join('\n'));
      }
      if (gate === 'GATE_2') {
        const c = json<{ charters: Array<{ class_name: string; test_class: string; fixtures_reused: string[]; scenarios: Array<{ id: string; kind: string; method: string; given: string; when: string; then: string }> }> }>(artifact);
        return markdownToHtml(c.charters.flatMap((ch) => [`## ${ch.class_name} → \`${ch.test_class}\``, `Reuses: ${ch.fixtures_reused.join(', ') || 'nothing'}`, ...ch.scenarios.map((s) => `- **${s.id}** (${s.kind}) ${s.method}: Given ${s.given}; when ${s.when}; then ${s.then}`)]).join('\n'));
      }
      if (gate === 'GATE_3') {
        const after = json<Array<{ className: string; lineMissed: number; lineCovered: number }>>(artifact);
        return markdownToHtml(['# Coverage after the new tests', ...after.slice(0, 30).map((c) => `- \`${c.className}\`: ${c.lineCovered}/${c.lineMissed + c.lineCovered} lines`)].join('\n'));
      }
      if (gate === 'GATE_4') {
        const p = json<{ artifacts: Record<string, string> }>(artifact);
        return markdownToHtml(p.artifacts.summary ? text(p.artifacts.summary) : '');
      }
    }
    return `<pre>${esc(text(artifact).slice(0, 20_000))}</pre>`;
  } catch (err) {
    return `<p>Cannot render this artifact: ${esc((err as Error).message)}</p>`;
  }
}

export function eventSummary(e: StoredEvent): string {
  const p = (e.payload ?? {}) as Record<string, any>;
  switch (e.type) {
    case 'STEP_DONE':
      return `${p.stepId} in ${((p.durationMs ?? 0) / 1000).toFixed(1)}s`;
    case 'STEP_STARTED':
      return String(p.stepId);
    case 'STEP_FAILED':
      return `${p.stepId}: ${p.error}`;
    case 'MODEL_CALL':
      return `${p.stepId} → ${p.model}: ${p.promptTokens}+${p.completionTokens} tokens, ${((p.durationMs ?? 0) / 1000).toFixed(1)}s, HTTP ${p.status}`;
    case 'AGENT_RUN':
      return `${p.step} via ${p.executor}: ${p.ok ? 'ok' : 'failed'} in ${((p.durationMs ?? 0) / 1000).toFixed(1)}s${p.errors?.length ? ` (${p.errors[0]})` : ''}`;
    case 'GATE_DECISION':
      return `${p.gate} ${p.decision} by ${String(p.credentialId).slice(0, 12)}…${p.reason ? ` — ${p.reason}` : ''}`;
    case 'AWAITING_GATE':
      return `${p.gate} on ${String(p.artifact).slice(0, 12)}…`;
    default:
      return JSON.stringify(p).slice(0, 180);
  }
}

// ---- time & token breakdown ---------------------------------------------------------------------

export interface RunStats {
  wallMs: number;
  activeMs: number;
  modelMs: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  budget: number | null;
  attempts: number;
  steps: Array<{ id: string; ms: number; reused: boolean }>;
  /** Tokens used since the latest attempt started (each attempt gets a fresh budget). */
  attemptTokens: number;
  agents: Array<{ step: string; executor: string; calls: number; promptTokens: number; completionTokens: number; modelMs: number; agentMs: number; runs: number; failed: number; lastOk: boolean | null; lastError: string }>;
}

/** Folds a run's events into per-step and per-agent time and token totals. */
export function runStats(events: StoredEvent[]): RunStats {
  const p = (e: StoredEvent) => (e.payload ?? {}) as Record<string, any>;
  const first = events[0] ? Date.parse(events[0].ts) : 0;
  const last = events.at(-1) ? Date.parse(events.at(-1)!.ts) : 0;
  // Latest completion of each step (a retry invalidates and re-runs later steps).
  const steps = new Map<string, { id: string; ms: number; reused: boolean }>();
  for (const e of events) {
    if (e.type === 'STEP_DONE') steps.set(p(e).stepId, { id: p(e).stepId, ms: p(e).durationMs ?? 0, reused: false });
    if (e.type === 'STEP_SKIPPED') steps.set(p(e).stepId, { ...(steps.get(p(e).stepId) ?? { id: p(e).stepId, ms: 0 }), reused: true });
  }
  const agents = new Map<string, RunStats['agents'][number]>();
  const agentFor = (step: string, executor = '') => {
    const key = step.replace(/-retry$/, '');
    if (!agents.has(key)) agents.set(key, { step: key, executor, calls: 0, promptTokens: 0, completionTokens: 0, modelMs: 0, agentMs: 0, runs: 0, failed: 0, lastOk: null, lastError: '' });
    const a = agents.get(key)!;
    if (executor) a.executor = executor;
    return a;
  };
  let calls = 0, promptTokens = 0, completionTokens = 0, modelMs = 0;
  for (const e of events) {
    if (e.type === 'MODEL_CALL') {
      const x = p(e);
      const a = agentFor(String(x.stepId), 'copilot');
      a.calls++; a.promptTokens += x.promptTokens ?? 0; a.completionTokens += x.completionTokens ?? 0; a.modelMs += x.durationMs ?? 0;
      calls++; promptTokens += x.promptTokens ?? 0; completionTokens += x.completionTokens ?? 0; modelMs += x.durationMs ?? 0;
    }
    if (e.type === 'AGENT_RUN') {
      const x = p(e);
      const a = agentFor(String(x.step), String(x.executor ?? ''));
      a.runs++; a.agentMs += x.durationMs ?? 0; a.lastOk = !!x.ok;
      if (!x.ok) { a.failed++; a.lastError = String((x.errors ?? [])[0] ?? '').slice(0, 200); }
    }
  }
  const budgets = events.filter((e) => e.type === 'BUDGET_SET' || e.type === 'RUN_STARTED').map((e) => p(e).tokens ?? p(e).budgetTokens).filter((x) => typeof x === 'number');
  const attempts = 1 + events.filter((e) => e.type === 'RUN_RESUMED').length;
  const lastStart = events.map((e) => e.type).lastIndexOf('RUN_RESUMED');
  const attemptTokens = events.slice(Math.max(0, lastStart)).filter((e) => e.type === 'MODEL_CALL').reduce((t, e) => t + (p(e).promptTokens ?? 0) + (p(e).completionTokens ?? 0), 0);
  const stepList = [...steps.values()];
  return {
    wallMs: last - first,
    activeMs: stepList.reduce((s, x) => s + x.ms, 0),
    modelMs, calls, promptTokens, completionTokens,
    budget: budgets.length ? Number(budgets.at(-1)) : null,
    attempts,
    attemptTokens,
    steps: stepList,
    agents: [...agents.values()],
  };
}

const fmtMs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

export function renderStats(s: RunStats): string {
  if (!s.steps.length && !s.calls) return '';
  const tiles = [
    ['Wall clock', fmtMs(s.wallMs), s.attempts > 1 ? `${s.attempts} attempts` : 'first to last event'],
    ['Step time', fmtMs(s.activeMs), 'latest run of each step'],
    ['Model calls', String(s.calls), `${fmtMs(s.modelMs)} inside the model`],
    ['Tokens', fmtTok(s.promptTokens + s.completionTokens), `${fmtTok(s.promptTokens)} prompt · ${fmtTok(s.completionTokens)} completion`],
    ['Budget', s.budget ? fmtTok(s.budget) : 'default', s.budget ? `${Math.round((s.attemptTokens / s.budget) * 100)}% used by the ${s.attempts > 1 ? 'latest attempt' : 'run'}` : ''],
  ];
  const maxStep = Math.max(1, ...s.steps.map((x) => x.ms));
  const maxTok = Math.max(1, ...s.agents.map((a) => a.promptTokens + a.completionTokens));
  const bar = (v: number, max: number, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(1, Math.round((v / max) * 100))}%"></span></div>`;
  const stepRows = s.steps
    .map((x) => `<tr><td class="mono">${esc(x.id)}</td><td class="num">${fmtMs(x.ms)}</td><td class="barcell">${bar(x.ms, maxStep)}</td><td class="muted">${x.reused ? 'reused' : ''}</td></tr>`)
    .join('');
  const agentRows = [...s.agents]
    .sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens) || b.agentMs - a.agentMs)
    .map((a) => {
      const tok = a.promptTokens + a.completionTokens;
      // The latest run decides the status; earlier failed attempts are history.
      const earlier = a.failed - (a.lastOk === false ? 1 : 0);
      const status = a.lastOk === null ? '' : a.lastOk
        ? `<span class="pill ok">ok</span>${earlier ? ` <span class="muted small" title="${esc(a.lastError)}">after ${earlier} failed</span>` : ''}`
        : `<span class="pill bad" title="${esc(a.lastError)}">failed</span>`;
      return `<tr><td class="mono">${esc(a.step)}</td><td>${esc(a.executor)}</td><td class="num">${a.calls || '—'}</td><td class="num">${tok ? fmtTok(tok) : '—'}</td><td class="barcell">${tok ? bar(tok, maxTok, 'tok') : ''}</td><td class="num">${a.modelMs ? fmtMs(a.modelMs) : '—'}</td><td class="num">${a.agentMs ? fmtMs(a.agentMs) : '—'}</td><td>${status}</td></tr>`;
    })
    .join('');
  return `<h2>Time &amp; tokens</h2><div class="tiles">${tiles.map(([k, v, sub]) => `<div class="tile"><div class="muted">${k}</div><div class="big">${v}</div><div class="muted small">${sub}</div></div>`).join('')}</div>
<h3>Steps</h3><table><thead><tr><th>Step</th><th class="num">Time</th><th></th><th></th></tr></thead><tbody>${stepRows}</tbody></table>
${agentRows ? `<h3>Agents and review units</h3><table><thead><tr><th>Unit / step</th><th>Executor</th><th class="num">Calls</th><th class="num">Tokens</th><th></th><th class="num">Model time</th><th class="num">Agent time</th><th></th></tr></thead><tbody>${agentRows}</tbody></table><p class="muted small">Model time is spent inside model calls (gateway-routed agents only; Codex runs on its own subscription and is not metered). Agent time includes tool use and retries.</p>` : ''}`;
}
