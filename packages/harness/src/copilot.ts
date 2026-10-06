import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunTokenSigner } from '@gatehouse/core';
import { run, scrubEnv } from '@gatehouse/targets';
import { extractJson, tail, validate } from './json.ts';
import type { AgentResult, AgentTask, ExecutorAdapter } from './types.ts';

export interface CopilotOptions {
  gatewayUrl: string;
  signer: RunTokenSigner;
  command?: string[];
  /** Read-only built-in tools; names verified against Copilot CLI 1.0.88. */
  readTools?: string[];
}

/**
 * GitHub Copilot CLI, BYOK through the Gatehouse gateway. Each task gets its own
 * COPILOT_HOME (no user MCP servers, plugins or memories), offline mode (no GitHub, no
 * telemetry, no web tools), repo instructions disabled, and an explicit tool allowlist.
 * COPILOT_ALLOW_ALL is never set: its "true" value would trust the repo's own MCP and hooks.
 */
export class CopilotAdapter implements ExecutorAdapter {
  readonly id = 'copilot' as const;
  readonly route = 'gateway' as const;

  constructor(private readonly options: CopilotOptions) {}

  async run(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    const home = join(task.stateDir, 'copilot-home');
    const logs = join(task.stateDir, 'logs');
    const taskDir = join(task.cwd, '.gatehouse');
    mkdirSync(home, { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    const taskFile = join(taskDir, `task-${task.stepId}.md`);
    const read = this.options.readTools ?? ['view', 'grep', 'glob'];
    // No shell tool in any scope: commands (builds, tests) are run by trusted code, never by the agent.
    const tools = task.scope === 'none' ? ['view'] : task.scope === 'write-repo' ? [...read, 'create', 'edit'] : read;

    let instructions = renderTask(task);
    const errors: string[] = [];
    let rawTail = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      writeFileSync(taskFile, instructions);
      const token = this.options.signer.issue(task.runId, task.stepId, task.timeoutMs + 60_000);
      const { env } = scrubEnv(process.env, {
        COPILOT_HOME: home,
        COPILOT_OFFLINE: 'true',
        COPILOT_AUTO_UPDATE: 'false',
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_PROVIDER_BASE_URL: this.options.gatewayUrl,
        COPILOT_PROVIDER_API_KEY: token,
        COPILOT_MODEL: task.tier,
        COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '120000',
        NO_COLOR: '1',
      });
      const argv = [
        ...(this.options.command ?? ['copilot']),
        '-p',
        `Read the file .gatehouse/task-${task.stepId}.md in the current directory and carry out the task it describes. Reply with only the final JSON object.`,
        '-s',
        '--no-custom-instructions',
        '--disable-builtin-mcps',
        '--no-auto-update',
        '--allow-all-tools',
        `--available-tools=${tools.join(',')}`,
        '--disallow-temp-dir',
        '--log-dir',
        logs,
      ];
      const result = await run(argv, { cwd: task.cwd, env, timeoutMs: task.timeoutMs });
      rawTail = tail(`${result.stdout}\n${result.stderr}`);
      if (result.error || result.timedOut || result.code !== 0) {
        errors.push(`attempt ${attempt}: copilot ${result.error ?? (result.timedOut ? 'timed out' : `exit ${result.code}`)}: ${tail(result.stderr || result.stdout, 3)}`);
        if (result.timedOut || result.error) break;
        continue;
      }
      let output: unknown;
      try {
        output = extractJson(result.stdout);
      } catch (err) {
        errors.push(`attempt ${attempt}: ${(err as Error).message}`);
        instructions = repairTask(task, result.stdout, [(err as Error).message]);
        continue;
      }
      const problems = validate(task.outputSchema, output);
      if (!problems.length) return { ok: true, output, errors, rawTail, durationMs: Date.now() - started, attempts: attempt };
      errors.push(`attempt ${attempt}: schema: ${problems.slice(0, 5).join('; ')}`);
      instructions = repairTask(task, result.stdout, problems);
    }
    return { ok: false, errors, rawTail, durationMs: Date.now() - started, attempts: 2 };
  }
}

export function renderTask(task: AgentTask): string {
  return [
    task.instructions.trim(),
    '',
    '## Output contract',
    'Reply with exactly one JSON object that validates against this JSON Schema. No prose before or after it.',
    '```json',
    JSON.stringify(task.outputSchema, null, 2),
    '```',
    '',
  ].join('\n');
}

function repairTask(task: AgentTask, previous: string, problems: string[]): string {
  return [
    renderTask(task),
    '## Correction needed',
    'Your previous reply did not satisfy the output contract:',
    ...problems.slice(0, 10).map((p) => `- ${p}`),
    '',
    'Previous reply (for reference):',
    '```',
    previous.slice(0, 8_000),
    '```',
    'Reply again with only the corrected JSON object.',
    '',
  ].join('\n');
}
