import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { gatehouseHome, gatehousePaths } from './paths.ts';

export type ConfigLayer = 'default' | 'team' | 'machine' | 'env' | 'override';

export interface LlmProvider {
  type: 'openai' | 'anthropic';
  baseUrl: string;
  /** Name in the SecretStore, never the key itself. */
  keySecret: string;
  /** PCI 12.8: only approved third-party providers may see in-scope repos. */
  tpspApproved: boolean;
  /** USD per million tokens; when absent, cost is reported as unknown and only token budgets apply. */
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
  /** Provider quota shared by every run on this machine; calls wait for room instead of failing. */
  rateLimit?: LlmRateLimit;
}

export interface LlmRateLimit {
  /** Requests per minute. */
  rpm?: number;
  /** Tokens per minute (prompt + completion). */
  tpm?: number;
  /** Whether cache-hit prompt tokens count toward tpm. Unknown for most company gateways: measure, then set. Default true. */
  countCachedTokens?: boolean;
}

export type SecretRef = { secret: string };

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string | SecretRef>;
  /** Tool manifest. Tools not listed are denied. Write tools are never exposed to agent steps. */
  tools: { read?: string[]; write?: string[]; deny?: string[] };
}

export interface GatehouseConfig {
  runtime: { target: 'host' | 'cell' };
  /** Version B sandbox cells (Docker). runc = hardened default; runsc = gVisor; kata = microVM. */
  cell: { runtime: 'runc' | 'runsc' | 'kata'; cpus: number; memoryGb: number; pidsLimit: number };
  paths: { home: string };
  scheduler: { maxParallelRuns: number; perRepoTestSteps: number };
  llm: {
    /** 0 = pick a free port per run. */
    gatewayPort: number;
    budgetTokensPerRun: number;
    providers: Record<string, LlmProvider>;
    /** Tier alias -> "provider:model". Steps name a tier, never a model. */
    tiers: Record<string, string>;
  };
  executors: { copilot: { enabled: boolean }; codex: { enabled: boolean; model: string } };
  github: { apiUrl: string; tokenSecret: string };
  review: {
    maxUnitLines: number;
    maxWorkers: number;
    stepTimeoutMinutes: number;
    /** "server:tool:argName" used to read a ticket during intake, e.g. "tracker:jira_get_issue:issue_key"; empty = off. */
    ticketTool: string;
  };
  mcp: { servers: Record<string, McpServerConfig> };
  console: { port: number; bind: string };
  pci: { defaultScope: 'cde' | 'connected' | 'out'; testPanAllowlist: string[] };
}

export interface LoadedConfig {
  config: Readonly<GatehouseConfig>;
  /** Layer that supplied each leaf value, keyed by dotted path. */
  sources: Record<string, ConfigLayer>;
}

export interface LoadConfigOptions {
  /** Directory holding the committed team config `gatehouse.config.yaml`. */
  projectDir?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Record<string, unknown>;
}

const TEAM_FILE = 'gatehouse.config.yaml';
/** Paths whose value is a user-keyed mapping: merged key by key across layers, validated as a whole. */
const RECORDS = new Set(['llm.providers', 'llm.tiers', 'mcp.servers']);
const ENV_PREFIX = 'GATEHOUSE__';

function defaults(env: NodeJS.ProcessEnv): GatehouseConfig {
  return {
    runtime: { target: 'host' },
    cell: { runtime: 'runc', cpus: 2, memoryGb: 4, pidsLimit: 1024 },
    paths: { home: gatehouseHome(env) },
    scheduler: { maxParallelRuns: 2, perRepoTestSteps: 1 },
    llm: {
      gatewayPort: 0,
      budgetTokensPerRun: 3_000_000,
      providers: {
        deepseek: { type: 'openai', baseUrl: 'https://api.deepseek.com', keySecret: 'llm.deepseek', tpspApproved: false },
      },
      tiers: {
        'tier-frontier': 'deepseek:deepseek-v4-pro',
        'tier-workhorse': 'deepseek:deepseek-flash',
        'tier-scale': 'deepseek:deepseek-flash',
      },
    },
    executors: { copilot: { enabled: true }, codex: { enabled: true, model: 'gpt-5.6-luna' } },
    github: { apiUrl: 'https://api.github.com', tokenSecret: 'github.pat' },
    review: { maxUnitLines: 400, maxWorkers: 2, stepTimeoutMinutes: 20, ticketTool: '' },
    mcp: { servers: {} },
    console: { port: 8787, bind: '127.0.0.1' },
    pci: {
      defaultScope: 'out',
      // Published brand test numbers; anything else that passes Luhn is treated as a real PAN.
      testPanAllowlist: ['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117'],
    },
  };
}

type Validator = (v: unknown) => string | null;
const isInt = (min: number, max: number): Validator => (v) =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? null : `must be an integer in [${min}, ${max}]`;
const oneOf = (...allowed: string[]): Validator => (v) =>
  typeof v === 'string' && allowed.includes(v) ? null : `must be one of ${allowed.join(', ')}`;
const isString: Validator = (v) => (typeof v === 'string' && v.length > 0 ? null : 'must be a non-empty string');
const isStringArray: Validator = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be a list of strings';
const isBool: Validator = (v) => (typeof v === 'boolean' ? null : 'must be true or false');
const isHttpsUrl: Validator = (v) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v) ? null : 'must be an https:// URL');

const isRecordOf = (check: (key: string, value: unknown) => string | null): Validator => (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'must be a mapping';
  for (const [k, value] of Object.entries(v)) {
    const problem = check(k, value);
    if (problem) return `entry "${k}" ${problem}`;
  }
  return null;
};

const providerCheck = (_: string, v: unknown): string | null => {
  const p = v as Partial<LlmProvider> | null;
  if (!p || typeof p !== 'object') return 'must be a mapping';
  if (p.type !== 'openai' && p.type !== 'anthropic') return 'type must be openai or anthropic';
  // Local model servers (vLLM, Ollama) may use plain http on loopback only.
  if (typeof p.baseUrl !== 'string' || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(p.baseUrl)) {
    return 'baseUrl must be https (or http on localhost)';
  }
  if (typeof p.keySecret !== 'string' || !p.keySecret) return 'keySecret is required';
  if (typeof p.tpspApproved !== 'boolean') return 'tpspApproved must be true or false';
  if (p.rateLimit !== undefined) {
    const r = p.rateLimit as LlmRateLimit | null;
    if (!r || typeof r !== 'object') return 'rateLimit must be a mapping';
    for (const k of ['rpm', 'tpm'] as const) if (r[k] !== undefined && (!Number.isInteger(r[k]) || r[k]! < 1)) return `rateLimit.${k} must be a positive integer`;
    if (r.countCachedTokens !== undefined && typeof r.countCachedTokens !== 'boolean') return 'rateLimit.countCachedTokens must be true or false';
  }
  return null;
};

const mcpServerCheck = (_: string, v: unknown): string | null => {
  const s = v as Partial<McpServerConfig> | null;
  if (!s || typeof s !== 'object') return 'must be a mapping';
  if (typeof s.command !== 'string' || !s.command) return 'command is required';
  if (s.args !== undefined && isStringArray(s.args)) return 'args must be a list of strings';
  if (!s.tools || typeof s.tools !== 'object') return 'tools manifest {read, write, deny} is required';
  for (const k of ['read', 'write', 'deny'] as const) {
    if (s.tools[k] !== undefined && isStringArray(s.tools[k])) return `tools.${k} must be a list of strings`;
  }
  for (const [name, val] of Object.entries(s.env ?? {})) {
    const ok = typeof val === 'string' || (val !== null && typeof val === 'object' && typeof (val as SecretRef).secret === 'string');
    if (!ok) return `env.${name} must be a string or { secret: NAME }`;
  }
  return null;
};

const tierCheck = (k: string, v: unknown): string | null => {
  if (!/^tier-[a-z0-9-]+$/.test(k)) return 'name must look like tier-<name>';
  return typeof v === 'string' && /^[\w.-]+:.+$/.test(v) ? null : 'must be "provider:model"';
};

const SCHEMA: Record<string, Validator> = {
  'runtime.target': oneOf('host', 'cell'),
  'cell.runtime': oneOf('runc', 'runsc', 'kata'),
  'cell.cpus': isInt(1, 64),
  'cell.memoryGb': isInt(1, 256),
  'cell.pidsLimit': isInt(64, 65536),
  'paths.home': isString,
  'scheduler.maxParallelRuns': isInt(1, 64),
  'scheduler.perRepoTestSteps': isInt(1, 16),
  'llm.gatewayPort': isInt(0, 65535),
  'llm.budgetTokensPerRun': isInt(1_000, 1_000_000_000),
  'llm.providers': isRecordOf(providerCheck),
  'llm.tiers': isRecordOf(tierCheck),
  'executors.copilot.enabled': isBool,
  'executors.codex.enabled': isBool,
  'executors.codex.model': isString,
  'github.apiUrl': isHttpsUrl,
  'github.tokenSecret': isString,
  'review.maxUnitLines': isInt(20, 5_000),
  'review.maxWorkers': isInt(1, 16),
  'review.stepTimeoutMinutes': isInt(1, 240),
  'review.ticketTool': (v) => (v === '' || (typeof v === 'string' && /^[\w.-]+:[\w.-]+:[\w.-]+$/.test(v)) ? null : 'must be "server:tool:argName" or empty'),
  'mcp.servers': isRecordOf(mcpServerCheck),
  'console.port': isInt(1, 65535),
  'console.bind': isString,
  'pci.defaultScope': oneOf('cde', 'connected', 'out'),
  'pci.testPanAllowlist': isStringArray,
};

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid Gatehouse config:\n  - ${issues.join('\n  - ')}`);
  }
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const merged = defaults(env) as unknown as Record<string, unknown>;
  const sources: Record<string, ConfigLayer> = {};
  for (const path of Object.keys(SCHEMA)) sources[path] = 'default';

  const apply = (layer: ConfigLayer, patch: Record<string, unknown>) => {
    for (const [path, value] of flatten(patch)) {
      if (!(path in SCHEMA)) throw new ConfigError([`${path}: unknown key (from ${layer})`]);
      if (RECORDS.has(path) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const current = getPath(merged, path) as Record<string, unknown> | undefined;
        setPath(merged, path, { ...(current ?? {}), ...(value as Record<string, unknown>) });
      } else {
        setPath(merged, path, value);
      }
      sources[path] = layer;
    }
  };

  if (options.projectDir) {
    const team = readYaml(join(options.projectDir, TEAM_FILE));
    if (team) apply('team', team);
  }
  const machine = readYaml(gatehousePaths(gatehouseHome(env)).machineConfig);
  if (machine) apply('machine', machine);
  apply('env', fromEnv(env));
  if (options.overrides) apply('override', options.overrides);

  const issues: string[] = [];
  for (const [path, validate] of Object.entries(SCHEMA)) {
    const problem = validate(getPath(merged, path));
    if (problem) issues.push(`${path} ${problem} (from ${sources[path]})`);
  }
  if (issues.length) throw new ConfigError(issues);

  return { config: deepFreeze(merged as unknown as GatehouseConfig), sources };
}

function readYaml(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  const doc = parseYaml(readFileSync(file, 'utf8')) as unknown;
  if (doc === null || doc === undefined) return null;
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError([`${file}: top level must be a mapping`]);
  return doc as Record<string, unknown>;
}

/** `GATEHOUSE__scheduler__maxParallelRuns=4` -> { scheduler: { maxParallelRuns: 4 } }. Values are parsed as YAML scalars. */
function fromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = new Map(Object.keys(SCHEMA).map((p) => [p.toLowerCase(), p]));
  for (const [name, raw] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith(ENV_PREFIX) || raw === undefined) continue;
    const dotted = name.slice(ENV_PREFIX.length).split('__').join('.');
    const path = known.get(dotted.toLowerCase());
    if (!path) throw new ConfigError([`${name}: does not match any config key`]);
    setPath(out, path, parseYaml(raw));
  }
  return out;
}

function* flatten(obj: Record<string, unknown>, prefix = ''): Generator<[string, unknown]> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !RECORDS.has(path)) {
      yield* flatten(value as Record<string, unknown>, path);
    } else {
      yield [path, value];
    }
  }
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, k) => (cur as Record<string, unknown> | undefined)?.[k], obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
