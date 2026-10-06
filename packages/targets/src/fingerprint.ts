import { existsSync, readFileSync } from 'node:fs';
import { cpus, homedir, platform, release, arch, totalmem } from 'node:os';
import { join } from 'node:path';
import { run, resolveExecutable, getEnv } from './proc.ts';

export interface ToolProbe {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  /** Extra parsed facts, e.g. which JDK Maven actually runs on. */
  detail?: Record<string, string>;
  error?: string;
  durationMs?: number;
}

export interface HostFingerprint {
  takenAt: string;
  os: { platform: string; release: string; arch: string; cpus: number; memoryGb: number; wsl: boolean };
  tools: Record<string, ToolProbe>;
  notes: string[];
}

interface ProbeSpec {
  name: string;
  argv: string[];
  parse: (output: string) => Pick<ToolProbe, 'version' | 'detail'>;
}

const firstMatch = (re: RegExp, s: string) => re.exec(s)?.[1]?.trim();

export function parseJavaVersion(output: string): Pick<ToolProbe, 'version' | 'detail'> {
  const version = firstMatch(/version "([^"]+)"/, output);
  const runtime = firstMatch(/^(.*Runtime Environment.*)$/m, output);
  return { version, detail: runtime ? { runtime } : undefined };
}

export function parseMavenVersion(output: string): Pick<ToolProbe, 'version' | 'detail'> {
  const version = firstMatch(/Apache Maven (\S+)/, output);
  const java = /Java version: ([^,]+), vendor: ([^,]+), runtime: (.+)/.exec(output);
  return {
    version,
    detail: java ? { javaVersion: java[1]!.trim(), javaVendor: java[2]!.trim(), javaRuntime: java[3]!.trim() } : undefined,
  };
}

/** "11.0.31" -> 11, "1.8.0_392" -> 8, "21" -> 21. */
export function javaMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const parts = version.split(/[._-]/).map((p) => Number.parseInt(p, 10));
  const major = parts[0] === 1 ? parts[1] : parts[0];
  return Number.isFinite(major) ? major : undefined;
}

const PROBES: ProbeSpec[] = [
  { name: 'git', argv: ['git', '--version'], parse: (o) => ({ version: firstMatch(/git version (\S+)/, o) }) },
  { name: 'java', argv: ['java', '-version'], parse: parseJavaVersion },
  { name: 'mvn', argv: ['mvn', '-v'], parse: parseMavenVersion },
  { name: 'gradle', argv: ['gradle', '-v'], parse: (o) => ({ version: firstMatch(/Gradle (\S+)/, o) }) },
  { name: 'node', argv: ['node', '-v'], parse: (o) => ({ version: firstMatch(/v(\S+)/, o) }) },
  { name: 'npm', argv: ['npm', '-v'], parse: (o) => ({ version: firstMatch(/^(\S+)/m, o) }) },
  { name: 'copilot', argv: ['copilot', '--version'], parse: (o) => ({ version: firstMatch(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/, o) }) },
  { name: 'codex', argv: ['codex', '--version'], parse: (o) => ({ version: firstMatch(/codex-cli (\S+)/, o) }) },
  { name: 'gh', argv: ['gh', '--version'], parse: (o) => ({ version: firstMatch(/gh version (\S+)/, o) }) },
  { name: 'docker', argv: ['docker', 'version', '--format', '{{.Server.Version}}'], parse: (o) => ({ version: o.trim().split(/\s/)[0] }) },
];

async function probe(spec: ProbeSpec, env: NodeJS.ProcessEnv): Promise<ToolProbe> {
  const path = resolveExecutable(spec.argv[0]!, env);
  if (!path) return { name: spec.name, found: false };
  const result = await run(spec.argv, { env, timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = spec.parse(output);
  const failed = result.error ?? (result.timedOut ? 'timed out' : result.code !== 0 ? `exit ${result.code}` : undefined);
  return {
    name: spec.name,
    found: true,
    path,
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(parsed.detail ? { detail: parsed.detail } : {}),
    ...(failed && !parsed.version ? { error: `${failed}: ${output.trim().split('\n')[0] ?? ''}`.trim() } : {}),
    durationMs: result.durationMs,
  };
}

/** Measures the toolchain exactly as build/test steps will see it (same env, same shims). */
export async function takeFingerprint(env: NodeJS.ProcessEnv): Promise<HostFingerprint> {
  const results = await Promise.all(PROBES.map((p) => probe(p, env)));
  const tools = Object.fromEntries(results.map((r) => [r.name, r]));
  return {
    takenAt: new Date().toISOString(),
    os: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpus: cpus().length,
      memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      wsl: isWsl(),
    },
    tools,
    notes: fingerprintNotes(tools, env),
  };
}

export function fingerprintNotes(tools: Record<string, ToolProbe>, env: NodeJS.ProcessEnv): string[] {
  const notes: string[] = [];
  const pathJava = javaMajor(tools.java?.version);
  const mavenJava = javaMajor(tools.mvn?.detail?.javaVersion);
  if (pathJava && mavenJava && pathJava !== mavenJava) {
    notes.push(
      `Maven runs on JDK ${mavenJava} while \`java\` on PATH is JDK ${pathJava}; build/test steps follow Maven's JDK.`,
    );
  }
  const home = getEnv(env, 'USERPROFILE') ?? getEnv(env, 'HOME') ?? homedir();
  for (const rc of ['mavenrc_pre.cmd', 'mavenrc_pre.bat', '.mavenrc']) {
    if (existsSync(join(home, rc))) notes.push(`Maven start-up script ${join(home, rc)} is active and is honoured as-is.`);
  }
  if (!tools.copilot?.found && !tools.codex?.found) notes.push('Neither Copilot CLI nor Codex CLI was found; agent steps cannot run.');
  if (tools.docker?.found && !tools.docker.version) notes.push('Docker CLI is installed but the daemon did not answer.');
  return notes;
}

function isWsl(): boolean {
  if (platform() !== 'linux') return false;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}
