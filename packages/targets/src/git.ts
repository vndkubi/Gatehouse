import { run, type RunResult } from './proc.ts';

export class GitError extends Error {
  constructor(readonly result: RunResult) {
    super(`git ${result.argv.slice(1).join(' ')} failed (${result.error ?? `exit ${result.code}`}): ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
}

/** Runs git with a minimal, credential-free environment unless one is supplied. */
export async function git(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; raw?: boolean } = {}): Promise<string> {
  const result = await run(['git', ...args], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
  });
  if (result.error || result.code !== 0) throw new GitError(result);
  // Porcelain formats put status in leading columns; callers parsing them ask for raw output.
  return options.raw ? result.stdout : result.stdout.trim();
}

const MIRROR_REFSPECS = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'];

/**
 * Bare copy of branches and tags only. `--mirror` would also pull every refs/pull/* on
 * GitHub (thousands on popular repos); PR heads are fetched one at a time when reviewed.
 */
export async function createMirror(source: string, mirrorDir: string): Promise<void> {
  await git(['clone', '--bare', '--no-tags', source, mirrorDir], { timeoutMs: 60 * 60_000 });
  await git(['-C', mirrorDir, 'config', '--unset-all', 'remote.origin.fetch']).catch(() => undefined);
  for (const spec of MIRROR_REFSPECS) await git(['-C', mirrorDir, 'config', '--add', 'remote.origin.fetch', spec]);
  // Long Windows paths inside deep Java packages break checkouts without this.
  await git(['-C', mirrorDir, 'config', 'core.longpaths', 'true']);
  await fetchMirror(mirrorDir);
}

export async function fetchMirror(mirrorDir: string): Promise<void> {
  await git(['-C', mirrorDir, 'fetch', '--prune', 'origin'], { timeoutMs: 30 * 60_000 });
}

/** Brings one PR head into the mirror as refs/gatehouse/pull/<n>. */
export async function fetchPullRequest(mirrorDir: string, number: number): Promise<string> {
  const ref = `refs/gatehouse/pull/${number}`;
  await git(['-C', mirrorDir, 'fetch', 'origin', `+refs/pull/${number}/head:${ref}`], { timeoutMs: 30 * 60_000 });
  return resolveCommit(mirrorDir, ref);
}

export async function defaultBranch(mirrorDir: string): Promise<string> {
  const ref = await git(['-C', mirrorDir, 'symbolic-ref', 'HEAD']);
  return ref.replace(/^refs\/heads\//, '');
}

export async function resolveCommit(mirrorDir: string, ref: string): Promise<string> {
  return git(['-C', mirrorDir, 'rev-parse', '--verify', `${ref}^{commit}`]);
}
