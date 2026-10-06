import type { RunResult } from './proc.ts';

/**
 * The seam between workflows and where work actually runs. Version A ships `host`
 * (the developer's own toolchain); Version B adds `cell` (sandbox / microVM) behind the
 * same interface, so workflows never change. See research/gatehouse-design/08.
 */
export interface ExecutionTarget {
  readonly kind: 'host' | 'cell';
  prepare(request: PrepareRequest): Promise<Workspace>;
  exec(workspace: Workspace, argv: string[], options?: ExecOptions): Promise<RunResult>;
  destroy(workspace: Workspace): Promise<void>;
}

export interface PrepareRequest {
  runId: string;
  repo: string;
  /** Commit to check out; frozen for the life of the run. */
  sha: string;
  /** Several workspaces per run (e.g. review + evidence); defaults to "work". */
  slot?: string;
  /** Resuming a run: return the existing checkout if it is pinned to the same commit. */
  reuse?: boolean;
  /** Toolchain the workspace will build with; cells use it to pick their image. Host ignores it. */
  env?: { stack: string; toolchain: Record<string, { requirement?: string; measured?: string }> };
}

export interface Workspace {
  runId: string;
  repo: string;
  sha: string;
  /** Directory the work happens in (worktree on host, mounted volume in a cell). */
  dir: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Variables Gatehouse adds after scrubbing (never user secrets). */
  extraEnv?: NodeJS.ProcessEnv;
}
