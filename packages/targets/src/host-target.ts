import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { scrubEnv } from './env.ts';
import { git } from './git.ts';
import { run, type RunResult } from './proc.ts';
import type { ExecOptions, ExecutionTarget, PrepareRequest, Workspace } from './types.ts';

export interface HostTargetOptions {
  /** Root for per-run directories, e.g. ~/.gatehouse/runs. */
  runsDir: string;
  /** Maps a registered repo name to its bare mirror. */
  mirrorFor: (repo: string) => string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Check out with LF line endings regardless of core.autocrlf (needed when a Linux cell runs the scripts). */
  forceLf?: boolean;
  /**
   * Copy the objects instead of borrowing them from the mirror. Needed when the checkout is
   * mounted somewhere the mirror path does not exist (a Linux cell): git-based build plugins
   * would otherwise fail with "Missing unknown <sha>".
   */
  selfContained?: boolean;
}

/**
 * Version A target: work happens on the developer's machine with their own toolchain.
 * Each run gets its own detached clone of the Gatehouse-owned mirror, never the user's checkout,
 * and commands run with a scrubbed environment. There is no filesystem or network boundary
 * here; see research/gatehouse-design/08 for what host mode does and does not protect.
 */
export class HostTarget implements ExecutionTarget {
  readonly kind = 'host' as const;

  constructor(readonly options: HostTargetOptions) {}

  async prepare(request: PrepareRequest): Promise<Workspace> {
    const runDir = join(this.options.runsDir, request.runId);
    const slot = request.slot ?? 'work';
    if (!/^[a-z0-9-]+$/.test(slot)) throw new Error(`invalid workspace slot ${slot}`);
    const dir = join(runDir, slot);
    if (existsSync(dir)) {
      if (request.reuse && (await git(['-C', dir, 'rev-parse', 'HEAD']).catch(() => '')) === request.sha) {
        return { runId: request.runId, repo: request.repo, sha: request.sha, dir };
      }
      throw new Error(`workspace already exists for run ${request.runId}`);
    }
    mkdirSync(runDir, { recursive: true });
    const mirror = this.options.mirrorFor(request.repo);
    // A standalone clone, not `git worktree`: JGit-based build plugins (git-commit-id, ...) cannot
    // resolve objects through a linked worktree of a bare repo. `--shared` borrows the mirror's
    // objects via alternates, so this costs no copy.
    await git(['clone', '--shared', '--no-checkout', '--quiet', mirror, dir]);
    await git(['-C', dir, 'config', 'core.longpaths', 'true']);
    if (this.options.forceLf) {
      await git(['-C', dir, 'config', 'core.autocrlf', 'false']);
      await git(['-C', dir, 'config', 'core.eol', 'lf']);
    }
    await git(['-C', dir, 'checkout', '--quiet', '--detach', request.sha]);
    if (this.options.selfContained) {
      await git(['-C', dir, 'repack', '-a', '-d', '-q'], { timeoutMs: 30 * 60_000 });
      rmSync(join(dir, '.git', 'objects', 'info', 'alternates'), { force: true });
    }
    // No remote: nothing in the workspace can push back into the mirror.
    await git(['-C', dir, 'remote', 'remove', 'origin']);
    return { runId: request.runId, repo: request.repo, sha: request.sha, dir };
  }

  async exec(workspace: Workspace, argv: string[], options: ExecOptions = {}): Promise<RunResult> {
    const [head, ...rest] = argv;
    if (!head) throw new Error('exec: empty argv');
    // Repo-relative tools (./mvnw, ./gradlew) resolve inside the workspace; PATHEXT picks mvnw.cmd on Windows.
    let command = head;
    if (head.startsWith('./') || head.startsWith('.\\')) {
      command = resolve(workspace.dir, head);
      if (!command.startsWith(workspace.dir + sep)) throw new Error(`refusing to run ${head} outside the workspace`);
    }
    const { env } = scrubEnv(this.options.baseEnv ?? process.env, options.extraEnv);
    return run([command, ...rest], { cwd: workspace.dir, env, timeoutMs: options.timeoutMs });
  }

  /** Removes the checkout only; run outputs next to it (reports, agent logs) stay. */
  async destroy(workspace: Workspace): Promise<void> {
    rmSync(workspace.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
