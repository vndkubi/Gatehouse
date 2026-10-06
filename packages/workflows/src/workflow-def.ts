import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAgent, REGISTRY, SCOPE_RANK, type AgentScope } from './registry.ts';

export interface StepDef {
  id: string;
  kind: 'code' | 'agent' | 'gate';
  agent?: string;
  executor?: string;
  tier?: string;
  scope?: 'none' | 'read-repo' | 'write-repo';
  gate?: string;
  params?: Record<string, unknown>;
}

export interface WorkflowDef {
  id: string;
  version: number;
  finalGate?: string;
  steps: StepDef[];
}

export function loadWorkflow(id: string): WorkflowDef {
  const def = parseYaml(readFileSync(join(REGISTRY, 'workflows', `${id}.yaml`), 'utf8')) as WorkflowDef;
  const problems = validateWorkflow(def);
  if (problems.length) throw new Error(`workflow ${id} is invalid:\n  - ${problems.join('\n  - ')}`);
  return def;
}

export function validateWorkflow(def: WorkflowDef): string[] {
  const problems: string[] = [];
  if (!def?.id || !Array.isArray(def.steps) || !def.steps.length) return ['workflow needs an id and at least one step'];
  const seen = new Set<string>();
  for (const s of def.steps) {
    if (!/^[a-z0-9-]+$/.test(s.id ?? '')) problems.push(`invalid step id ${String(s.id)}`);
    if (seen.has(s.id)) problems.push(`duplicate step ${s.id}`);
    seen.add(s.id);
    if (!['code', 'agent', 'gate'].includes(s.kind)) problems.push(`${s.id}: kind must be code, agent or gate`);
    if (s.kind === 'agent' && !s.executor) problems.push(`${s.id}: agent steps must name an executor role`);
    if (s.kind === 'gate' && !/^GATE_[A-Z0-9_]+$/.test(s.gate ?? '')) problems.push(`${s.id}: gate steps must name a GATE_*`);
    if (s.scope && !['none', 'read-repo', 'write-repo'].includes(s.scope)) problems.push(`${s.id}: unknown scope ${s.scope}`);
    if (s.tier && !/^tier-[a-z0-9-]+$/.test(s.tier)) problems.push(`${s.id}: tier must look like tier-<name>`);
    problems.push(...agentGrantProblems(s));
  }
  return problems;
}

/** Agents a step may run: `agent`, plus agent names in params (unit agents, TDD pair). */
function stepAgents(s: StepDef): string[] {
  const names = s.agent ? [s.agent] : [];
  const p = s.params ?? {};
  if (p.agents && typeof p.agents === 'object') names.push(...Object.values(p.agents as Record<string, string>));
  for (const k of ['testWriter', 'implementer']) if (typeof p[k] === 'string') names.push(p[k] as string);
  return names;
}

/** A step may narrow an agent's declared tool scope, never widen it. */
function agentGrantProblems(s: StepDef): string[] {
  const problems: string[] = [];
  for (const name of stepAgents(s)) {
    try {
      const spec = loadAgent(name);
      const scope = (s.scope ?? 'none') as AgentScope;
      if (SCOPE_RANK[scope] > SCOPE_RANK[spec.meta.scope]) problems.push(`${s.id}: grants ${scope} but agent ${name} declares at most ${spec.meta.scope}`);
    } catch (err) {
      problems.push(`${s.id}: ${(err as Error).message}`);
    }
  }
  return problems;
}

/** The declared steps and the code must agree exactly; drift in either direction is an error. */
export function bindSteps<T>(def: WorkflowDef, impls: Record<string, T>): Array<{ def: StepDef; impl: T }> {
  const declared = def.steps.map((s) => s.id);
  const missing = declared.filter((id) => !(id in impls));
  const extra = Object.keys(impls).filter((id) => !declared.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`workflow ${def.id} and its implementation disagree: ${[...missing.map((m) => `no code for ${m}`), ...extra.map((e) => `${e} not declared`)].join('; ')}`);
  }
  return def.steps.map((d) => ({ def: d, impl: impls[d.id]! }));
}

export function stepParam<T>(def: WorkflowDef, step: string, key: string, fallback: T): T {
  const v = def.steps.find((s) => s.id === step)?.params?.[key];
  return (v === undefined ? fallback : v) as T;
}

export function stepDef(def: WorkflowDef, step: string): StepDef {
  const s = def.steps.find((x) => x.id === step);
  if (!s) throw new Error(`workflow ${def.id} has no step ${step}`);
  return s;
}
