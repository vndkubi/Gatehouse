import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isProtectedPath, quotedIn, topoSort } from './pipeline.ts';

export interface PbiManifest {
  title: string;
  problem: string;
  actors: string[];
  decision_variables: Array<{ name: string; values: string[] }>;
  acceptance_criteria: Array<{ id: string; text: string; kind: 'SOURCE' | 'DERIVED' | 'INFERRED'; source_quote: string }>;
  business_matrix: Array<{ id: string; conditions: string; expected: string; kind: 'positive' | 'negative' | 'boundary'; covers: string[] }>;
  scenarios: Array<{ id: string; given: string; when: string; then: string; covers: string[] }>;
  open_questions: Array<{ id: string; question: string; blocking: boolean }>;
}

export interface Spec {
  overview: string;
  functional_requirements: Array<{ id: string; text: string; traces: string[] }>;
  non_functional: string[];
  affected_components: Array<{ path: string; reason: string; is_new: boolean }>;
  data_changes: string[];
  api_changes: string[];
  out_of_scope: string[];
}

export interface Plan {
  approach: string;
  steps: Array<{ id: string; description: string; files: Array<{ path: string; change: 'create' | 'modify' | 'delete' }>; traces: string[] }>;
  test_strategy: Array<{ scenario_id: string; test_class: string; kind: 'unit' | 'integration' }>;
  risks: string[];
}

export interface Tasks {
  tasks: Array<{ id: string; title: string; step_ids: string[]; files: string[]; test_class: string; scenario_ids: string[]; depends_on: string[] }>;
}

export interface ArtifactIssue {
  severity: 'blocker' | 'major' | 'minor';
  artifact: 'pbi' | 'spec' | 'plan' | 'tasks';
  description: string;
  evidence: string;
}

const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
const inside = (ws: string, p: string) => resolve(ws, p).startsWith(resolve(ws) + sep);

/** PBI contract (blueprint v1 pbi-stage-contract): provenance, traceability, matrix coverage. */
export function validatePbi(m: PbiManifest, packet: string): string[] {
  const p: string[] = [];
  const acIds = m.acceptance_criteria.map((a) => a.id);
  for (const d of dupes(acIds)) p.push(`duplicate acceptance criterion id ${d}`);
  if (!acIds.length) p.push('no acceptance criteria');
  for (const a of m.acceptance_criteria) {
    if (!/^AC\d+$/.test(a.id)) p.push(`acceptance criterion id ${a.id} must look like AC1`);
    if (a.kind !== 'INFERRED' && !quotedIn(packet, a.source_quote)) p.push(`${a.id} is ${a.kind} but its source_quote is not found verbatim in the ticket`);
    if (a.kind === 'INFERRED' && !m.open_questions.some((q) => q.question.includes(a.id))) p.push(`${a.id} is INFERRED: add an open question that mentions ${a.id} asking to confirm it`);
    if (!m.scenarios.some((s) => s.covers.includes(a.id))) p.push(`${a.id} is not covered by any scenario`);
    if (!m.business_matrix.some((r) => r.covers.includes(a.id))) p.push(`${a.id} is not covered by any business matrix row`);
  }
  for (const s of m.scenarios) for (const c of s.covers) if (!acIds.includes(c)) p.push(`scenario ${s.id} covers unknown ${c}`);
  for (const r of m.business_matrix) for (const c of r.covers) if (!acIds.includes(c)) p.push(`matrix row ${r.id} covers unknown ${c}`);
  for (const d of dupes(m.scenarios.map((s) => s.id))) p.push(`duplicate scenario id ${d}`);
  if (m.decision_variables.length && !m.business_matrix.some((r) => r.kind !== 'positive')) p.push('the business matrix needs at least one negative or boundary row');
  return p;
}

export function unansweredBlocking(m: PbiManifest, answered: Set<string>): string[] {
  return m.open_questions.filter((q) => q.blocking && !answered.has(q.id)).map((q) => `${q.id}: ${q.question}`);
}

export function validateSpec(s: Spec, pbi: PbiManifest, ws: string): string[] {
  const p: string[] = [];
  const acIds = new Set(pbi.acceptance_criteria.map((a) => a.id));
  for (const d of dupes(s.functional_requirements.map((f) => f.id))) p.push(`duplicate requirement id ${d}`);
  for (const f of s.functional_requirements) {
    if (!/^FR\d+$/.test(f.id)) p.push(`requirement id ${f.id} must look like FR1`);
    for (const t of f.traces) if (!acIds.has(t)) p.push(`${f.id} traces unknown ${t}`);
  }
  for (const a of acIds) if (!s.functional_requirements.some((f) => f.traces.includes(a))) p.push(`${a} is not traced by any functional requirement`);
  for (const c of s.affected_components) {
    if (!inside(ws, c.path)) p.push(`${c.path} is outside the repository`);
    else if (!c.is_new && !existsSync(resolve(ws, c.path))) p.push(`${c.path} does not exist (set is_new: true if it is new)`);
    else if (c.is_new && existsSync(resolve(ws, c.path))) p.push(`${c.path} already exists but is marked new`);
  }
  return p;
}

export function validatePlan(plan: Plan, spec: Spec, pbi: PbiManifest, ws: string): string[] {
  const p: string[] = [];
  const frIds = new Set(spec.functional_requirements.map((f) => f.id));
  for (const d of dupes(plan.steps.map((s) => s.id))) p.push(`duplicate step id ${d}`);
  for (const s of plan.steps) {
    for (const t of s.traces) if (!frIds.has(t)) p.push(`step ${s.id} traces unknown ${t}`);
    for (const f of s.files) {
      if (!inside(ws, f.path)) p.push(`${f.path} is outside the repository`);
      else if (isProtectedPath(f.path)) p.push(`${f.path} is a build/CI/agent-config file; automated implementation may not change it — find a solution without it or raise it as an open question`);
      else if (f.change === 'create' && existsSync(resolve(ws, f.path))) p.push(`${f.path} already exists (use modify)`);
      else if (f.change !== 'create' && !existsSync(resolve(ws, f.path))) p.push(`${f.path} does not exist (use create)`);
    }
  }
  for (const fr of frIds) if (!plan.steps.some((s) => s.traces.includes(fr))) p.push(`${fr} is not covered by any plan step`);
  const scenarioIds = new Set(pbi.scenarios.map((s) => s.id));
  for (const sc of scenarioIds) if (!plan.test_strategy.some((t) => t.scenario_id === sc)) p.push(`scenario ${sc} has no test in the test strategy`);
  for (const t of plan.test_strategy) {
    if (!scenarioIds.has(t.scenario_id)) p.push(`test strategy maps unknown scenario ${t.scenario_id}`);
    if (!/^[A-Za-z_][\w.$/-]*$/.test(t.test_class)) p.push(`invalid test class name ${t.test_class}`);
  }
  return p;
}

export function validateTasks(t: Tasks, plan: Plan): string[] {
  const p: string[] = [];
  const stepIds = new Set(plan.steps.map((s) => s.id));
  const testClasses = new Set(plan.test_strategy.map((x) => x.test_class));
  const scenarios = new Set(plan.test_strategy.map((x) => x.scenario_id));
  for (const d of dupes(t.tasks.map((x) => x.id))) p.push(`duplicate task id ${d}`);
  for (const task of t.tasks) {
    for (const s of task.step_ids) if (!stepIds.has(s)) p.push(`${task.id} references unknown plan step ${s}`);
    if (!testClasses.has(task.test_class)) p.push(`${task.id} uses test class ${task.test_class}, which is not in the plan's test strategy`);
    for (const sc of task.scenario_ids) if (!scenarios.has(sc)) p.push(`${task.id} references unknown scenario ${sc}`);
  }
  for (const s of stepIds) if (!t.tasks.some((x) => x.step_ids.includes(s))) p.push(`plan step ${s} is not assigned to any task`);
  try {
    topoSort(t.tasks);
  } catch (err) {
    p.push((err as Error).message);
  }
  return p;
}

// ---- rendered views (never model-authored) --------------------------------------------------------

export function renderPbi(m: PbiManifest): string {
  return [
    `# ${m.title}`,
    '',
    m.problem,
    '',
    `**Actors:** ${m.actors.join(', ') || '—'}`,
    '',
    '## Acceptance criteria',
    ...m.acceptance_criteria.map((a) => `- **${a.id}** (${a.kind}) ${a.text}${a.source_quote ? ` — _"${a.source_quote}"_` : ''}`),
    '',
    '## Decision variables',
    ...m.decision_variables.map((d) => `- ${d.name}: ${d.values.join(' | ')}`),
    '',
    '## Business matrix',
    '| Row | Kind | Conditions | Expected | Covers |',
    '|---|---|---|---|---|',
    ...m.business_matrix.map((r) => `| ${r.id} | ${r.kind} | ${r.conditions} | ${r.expected} | ${r.covers.join(', ')} |`),
    '',
    '## Scenarios',
    ...m.scenarios.map((s) => `- **${s.id}** Given ${s.given}; when ${s.when}; then ${s.then}. _(${s.covers.join(', ')})_`),
    '',
    '## Open questions',
    ...(m.open_questions.length ? m.open_questions.map((q) => `- **${q.id}**${q.blocking ? ' (blocking)' : ''} ${q.question}`) : ['_None._']),
    '',
  ].join('\n');
}

export function renderTraceability(m: PbiManifest, spec?: Spec, plan?: Plan): string {
  const rows = m.acceptance_criteria.map((a) => {
    const frs = spec?.functional_requirements.filter((f) => f.traces.includes(a.id)).map((f) => f.id) ?? [];
    const steps = plan?.steps.filter((s) => s.traces.some((t) => frs.includes(t))).map((s) => s.id) ?? [];
    const scenarios = m.scenarios.filter((s) => s.covers.includes(a.id)).map((s) => s.id);
    const tests = plan?.test_strategy.filter((t) => scenarios.includes(t.scenario_id)).map((t) => t.test_class.split('.').pop()) ?? [];
    return `| ${a.id} | ${m.business_matrix.filter((r) => r.covers.includes(a.id)).map((r) => r.id).join(', ')} | ${scenarios.join(', ')} | ${frs.join(', ') || '—'} | ${steps.join(', ') || '—'} | ${[...new Set(tests)].join(', ') || '—'} |`;
  });
  return ['# Traceability', '', '| AC | Matrix | Scenarios | Requirements | Plan steps | Tests |', '|---|---|---|---|---|---|', ...rows, ''].join('\n');
}

export function renderSpec(s: Spec): string {
  return [
    '# Specification',
    '',
    s.overview,
    '',
    '## Functional requirements',
    ...s.functional_requirements.map((f) => `- **${f.id}** ${f.text} _(${f.traces.join(', ')})_`),
    '',
    '## Non-functional',
    ...(s.non_functional.length ? s.non_functional.map((x) => `- ${x}`) : ['_None._']),
    '',
    '## Affected components',
    ...s.affected_components.map((c) => `- \`${c.path}\`${c.is_new ? ' (new)' : ''}: ${c.reason}`),
    '',
    '## Data changes',
    ...(s.data_changes.length ? s.data_changes.map((x) => `- ${x}`) : ['_None._']),
    '',
    '## API changes',
    ...(s.api_changes.length ? s.api_changes.map((x) => `- ${x}`) : ['_None._']),
    '',
    '## Out of scope',
    ...(s.out_of_scope.length ? s.out_of_scope.map((x) => `- ${x}`) : ['_None._']),
    '',
  ].join('\n');
}

export function renderPlan(p: Plan): string {
  return [
    '# Implementation plan',
    '',
    p.approach,
    '',
    '## Steps',
    ...p.steps.flatMap((s) => [`- **${s.id}** ${s.description} _(${s.traces.join(', ')})_`, ...s.files.map((f) => `  - ${f.change} \`${f.path}\``)]),
    '',
    '## Test strategy',
    ...p.test_strategy.map((t) => `- ${t.scenario_id} → \`${t.test_class}\` (${t.kind})`),
    '',
    '## Risks',
    ...(p.risks.length ? p.risks.map((r) => `- ${r}`) : ['_None._']),
    '',
  ].join('\n');
}

export function renderTasks(t: Tasks): string {
  return ['# Tasks', '', ...topoSort(t.tasks).map((x) => `- **${x.id}** ${x.title} — test \`${x.test_class}\` (${x.scenario_ids.join(', ')}); steps ${x.step_ids.join(', ')}${x.depends_on.length ? `; after ${x.depends_on.join(', ')}` : ''}`), ''].join('\n');
}

export function renderIssues(issues: ArtifactIssue[]): string {
  if (!issues.length) return '# Artifact review\n\nNo issues found by the independent reviewer.\n';
  return ['# Artifact review', '', ...issues.map((i) => `- **${i.severity}** [${i.artifact}] ${i.description}${i.evidence ? ` — ${i.evidence}` : ''}`), ''].join('\n');
}
