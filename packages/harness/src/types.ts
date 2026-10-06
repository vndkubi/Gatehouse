/** What an agent step may touch. Enforced by tool allowlists and by choosing its working directory. */
export type ToolScope =
  /** Quarantined: runs in a scratch dir holding only its inputs; no tools beyond reading that dir. */
  | 'none'
  /** Read-only access to the prepared (masked) workspace. */
  | 'read-repo'
  /** May create and edit files in the workspace; never runs commands (trusted code runs the tests). */
  | 'write-repo';

export interface AgentTask {
  runId: string;
  stepId: string;
  /** Complete instructions and data. Untrusted content must already be DLP'd and enveloped. */
  instructions: string;
  /** JSON Schema the answer must satisfy (strict: every property required, no extras). */
  outputSchema: Record<string, unknown>;
  scope: ToolScope;
  /** Workspace (read-repo) or scratch dir (none). */
  cwd: string;
  /** Per-step private dir for CLI homes, logs and task files; outside any workspace. */
  stateDir: string;
  /** Gateway tier alias; used by gateway-routed executors. */
  tier: string;
  timeoutMs: number;
}

export interface AgentResult {
  ok: boolean;
  output?: unknown;
  errors: string[];
  /** Last lines of the executor's output, for the event log (never parsed as truth). */
  rawTail: string;
  durationMs: number;
  attempts: number;
}

export interface ExecutorAdapter {
  readonly id: 'copilot' | 'codex';
  /** How the executor reaches its model; feeds the PCI policy check. */
  readonly route: 'gateway' | 'subscription';
  run(task: AgentTask): Promise<AgentResult>;
}
