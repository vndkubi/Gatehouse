import { createHash } from 'node:crypto';
import type { ArtifactStore, EventStore, GatehouseConfig, RepoRegistry } from '@gatehouse/core';
import { HostTarget, run, type ExecOptions, type ExecutionTarget, type PrepareRequest, type RunResult, type Workspace } from '@gatehouse/targets';

export interface CellTargetOptions {
  host: HostTarget;
  config: GatehouseConfig;
  artifacts: ArtifactStore;
  events: EventStore;
  repos: RepoRegistry;
  docker?: string;
}

const RUNTIME_FLAG: Record<string, string | null> = { runc: null, runsc: 'runsc', kata: 'io.containerd.kata.v2' };

/**
 * Version B target (design 05 §2): every build/test command runs in a throwaway container with
 * no network, all capabilities dropped, a read-only root filesystem and resource limits. The
 * checkout is materialized on the host by trusted code (LF line endings) and bind-mounted;
 * dependencies come from a per-repo cache volume filled once by `warm`, the only step that
 * gets network. Agents keep running on the host with read-only tools ("sandbox as a tool").
 */
export class CellTarget implements ExecutionTarget {
  readonly kind = 'cell' as const;
  private readonly lfHost: HostTarget;
  private readonly images = new Map<string, string>();
  private readonly docker: string;

  constructor(private readonly o: CellTargetOptions) {
    this.docker = o.docker ?? 'docker';
    this.lfHost = new HostTarget({ runsDir: o.host.options.runsDir, mirrorFor: o.host.options.mirrorFor, forceLf: true, selfContained: true });
  }

  async prepare(request: PrepareRequest): Promise<Workspace> {
    const ws = await this.lfHost.prepare(request);
    this.images.set(ws.dir, imageFor(request.env));
    return ws;
  }

  /** Runs one command in a fresh, offline container. */
  async exec(ws: Workspace, argv: string[], options: ExecOptions = {}): Promise<RunResult> {
    return this.runInCell(ws, argv, { ...options, network: false });
  }

  /**
   * Fills the repo's dependency cache by running a trusted command (from the base branch) once
   * with network access. Everything afterwards runs offline against that cache.
   */
  async warm(ws: Workspace, argv: string[], timeoutMs: number): Promise<RunResult> {
    return this.runInCell(ws, argv, { timeoutMs, network: true, offlineFlag: false });
  }

  async destroy(ws: Workspace): Promise<void> {
    this.images.delete(ws.dir);
    await this.lfHost.destroy(ws);
  }

  /** Whether the configured runtime is registered with Docker (gVisor/Kata must be installed first). */
  async available(): Promise<{ ok: boolean; reason?: string; runtimes: string[] }> {
    const r = await run([this.docker, 'info', '--format', '{{json .Runtimes}}'], { timeoutMs: 30_000 });
    if (r.error || r.code !== 0) return { ok: false, reason: 'docker is not running', runtimes: [] };
    let runtimes: string[] = [];
    try {
      runtimes = Object.keys(JSON.parse(r.stdout) as Record<string, unknown>);
    } catch {
      runtimes = [];
    }
    const flag = RUNTIME_FLAG[this.o.config.cell.runtime];
    if (flag && !runtimes.includes(flag) && !runtimes.includes(this.o.config.cell.runtime)) {
      return { ok: false, reason: `runtime ${this.o.config.cell.runtime} is not installed in Docker (have: ${runtimes.join(', ')})`, runtimes };
    }
    return { ok: true, runtimes };
  }

  private async runInCell(ws: Workspace, argv: string[], opts: ExecOptions & { network: boolean; offlineFlag?: boolean }): Promise<RunResult> {
    const image = this.images.get(ws.dir) ?? imageFor(undefined);
    const c = this.o.config.cell;
    const runtime = RUNTIME_FLAG[c.runtime];
    const cache = cacheVolume(ws.repo);
    const name = `gatehouse-${createHash('sha256').update(`${ws.runId}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12)}`;
    const command = toCellCommand(argv, opts.offlineFlag !== false && !opts.network);
    const dockerArgs = [
      this.docker, 'run', '--rm', '--name', name,
      ...(runtime ? ['--runtime', runtime] : []),
      '--network', opts.network ? 'bridge' : 'none',
      '--cpus', String(c.cpus), '--memory', `${c.memoryGb}g`, '--pids-limit', String(c.pidsLimit),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,exec,size=1g',
      '-v', `${ws.dir}:/work`, '-w', '/work',
      '-v', `${cache}:/cache`,
      // The root filesystem is read-only: every tool's home and config dir lives on the cache volume.
      // JVMs take user.home from passwd, not HOME, so it is set for all of them (JGit, Surefire forks).
      '-e', 'HOME=/cache/home', '-e', 'XDG_CONFIG_HOME=/cache/home/.config', '-e', 'JAVA_TOOL_OPTIONS=-Duser.home=/cache/home',
      '-e', 'MAVEN_OPTS=-Dmaven.repo.local=/cache/m2', '-e', 'npm_config_cache=/cache/npm',
      '-e', 'GRADLE_USER_HOME=/cache/gradle', '-e', 'TZ=UTC', '-e', 'CI=true',
      ...Object.entries(opts.extraEnv ?? {}).flatMap(([k, v]) => (v === undefined ? [] : ['-e', `${k}=${v}`])),
      image,
      ...command,
    ];
    const result = await run(dockerArgs, { timeoutMs: opts.timeoutMs });
    if (result.timedOut) await run([this.docker, 'rm', '-f', name], { timeoutMs: 30_000 });
    return { ...result, argv };
  }
}

/** Curated base images per toolchain; pinned by major version from the env spec. */
export function imageFor(env: PrepareRequest['env']): string {
  if (env?.stack === 'node') {
    const major = /(\d+)/.exec(env.toolchain.node?.requirement ?? env.toolchain.node?.measured ?? '')?.[1] ?? '22';
    return `node:${major}-bookworm-slim`;
  }
  const jdk = /(\d+)/.exec(env?.toolchain.jdk?.requirement ?? env?.toolchain.jdk?.measured ?? '')?.[1] ?? '21';
  return `eclipse-temurin:${jdk}-jdk`;
}

/** Repo-relative scripts run through sh (no exec bit needed); Maven gets -o when offline. */
export function toCellCommand(argv: string[], offline: boolean): string[] {
  const [head, ...rest] = argv;
  if (!head) throw new Error('empty command');
  const isScript = head.startsWith('./') || head.startsWith('.\\');
  const cmd = isScript ? ['sh', `/work/${head.slice(2).replace(/\\/g, '/')}`] : [head];
  const maven = /(^|\/)mvnw?$/.test(head.replace(/\\/g, '/'));
  return [...cmd, ...(maven && offline && !rest.includes('-o') ? ['-o'] : []), ...rest];
}

export const cacheVolume = (repo: string) => `gatehouse-cache-${volumeName(repo)}`;
const volumeName = (repo: string) => repo.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
