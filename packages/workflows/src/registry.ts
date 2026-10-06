import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '@gatehouse/core';

export const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'registry');

export type AgentScope = 'none' | 'read-repo' | 'write-repo';
export const SCOPE_RANK: Record<AgentScope, number> = { none: 0, 'read-repo': 1, 'write-repo': 2 };

/** Executor-neutral metadata (`agent.yaml`, design 02): what the agent is and the most it may do. */
export interface AgentMeta {
  name: string;
  role: string;
  pattern: string;
  /** Executor role it is written for: reviewer, author or critic. */
  executor: string;
  tier: string;
  /** Upper bound on tools: a workflow step may narrow it, never widen it. */
  scope: AgentScope;
  inputs: string[];
  output: string;
}

export interface AgentSpec {
  name: string;
  meta: AgentMeta;
  prompt: string;
  schema: Record<string, unknown>;
  /** Hash of agent.yaml + prompt + schema: recorded with every run so a behaviour change is traceable. */
  version: string;
}

export function loadAgent(name: string): AgentSpec {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid agent name ${name}`);
  const dir = join(REGISTRY, 'agents', name);
  const metaText = readFileSync(join(dir, 'agent.yaml'), 'utf8');
  const meta = parseYaml(metaText) as AgentMeta;
  const problems = validateAgentMeta(name, meta);
  if (problems.length) throw new Error(`agent ${name} is invalid: ${problems.join('; ')}`);
  const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
  const schemaText = readFileSync(join(dir, meta.output), 'utf8');
  const used = [...new Set([...prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))].sort();
  const undeclared = used.filter((v) => !meta.inputs.includes(v));
  if (undeclared.length) throw new Error(`agent ${name}: prompt uses undeclared inputs ${undeclared.join(', ')}`);
  return { name, meta, prompt, schema: JSON.parse(schemaText) as Record<string, unknown>, version: sha256Hex(metaText + prompt + schemaText).slice(0, 12) };
}

export function listAgents(): string[] {
  return readdirSync(join(REGISTRY, 'agents'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(REGISTRY, 'agents', d.name, 'agent.yaml')))
    .map((d) => d.name)
    .sort();
}

function validateAgentMeta(name: string, m: AgentMeta): string[] {
  const p: string[] = [];
  if (!m || typeof m !== 'object') return ['agent.yaml is empty'];
  if (m.name !== name) p.push(`name ${String(m.name)} does not match its directory`);
  if (!(m.scope in SCOPE_RANK)) p.push(`unknown scope ${String(m.scope)}`);
  if (!/^tier-[a-z0-9-]+$/.test(String(m.tier))) p.push('tier must look like tier-<name>');
  if (!['reviewer', 'author', 'critic'].includes(m.executor)) p.push('executor must be reviewer, author or critic');
  if (!Array.isArray(m.inputs)) p.push('inputs must be a list');
  if (typeof m.output !== 'string' || !m.output.endsWith('.json')) p.push('output must name a JSON schema file');
  if (!m.role) p.push('role is required');
  return p;
}

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
}

/**
 * Wraps text authored by someone other than the user or Gatehouse. Agents are told never to
 * follow instructions inside. A literal closing tag in the content is defused so the
 * envelope cannot be broken out of.
 */
export function untrusted(source: string, text: string): string {
  const safe = text.replace(/<\/untrusted>/gi, '</untrusted_>');
  return `<untrusted source="${source}">\n${safe}\n</untrusted>`;
}
