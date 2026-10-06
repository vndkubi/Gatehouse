import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, scrubEnv } from '@gatehouse/targets';
import { renderTask } from './copilot.ts';
import { tail, validate } from './json.ts';
import type { AgentResult, AgentTask, ExecutorAdapter } from './types.ts';

export interface CodexOptions {
  model: string;
  command?: string[];
  /** Where the user's Codex login lives; only auth.json and the model cache are copied from it. */
  sourceHome?: string;
}

/**
 * OpenAI Codex CLI on the user's ChatGPT subscription (route "subscription": Gatehouse cannot
 * inspect its traffic, so policy limits it to pci.scope=out repos). Each task gets a fresh
 * CODEX_HOME holding only a copy of auth.json, plus --ignore-user-config/--ignore-rules, so
 * the user's own AGENTS.md, MCP servers and rules never leak in. Structured output is
 * enforced by Codex itself (--output-schema) and re-validated here.
 */
export class CodexAdapter implements ExecutorAdapter {
  readonly id = 'codex' as const;
  readonly route = 'subscription' as const;

  constructor(private readonly options: CodexOptions) {}

  async run(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    const home = join(task.stateDir, 'codex-home');
    mkdirSync(home, { recursive: true });
    const source = this.options.sourceHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    for (const f of ['auth.json', 'models_cache.json']) {
      if (existsSync(join(source, f))) copyFileSync(join(source, f), join(home, f));
    }
    if (!existsSync(join(home, 'auth.json'))) {
      return { ok: false, errors: [`no Codex login found in ${source}; run \`codex login\` first`], rawTail: '', durationMs: 0, attempts: 0 };
    }
    const schemaFile = join(task.stateDir, 'output.schema.json');
    const outFile = join(task.stateDir, 'codex-last.json');
    writeFileSync(schemaFile, JSON.stringify(task.outputSchema));
    rmSync(outFile, { force: true });

    const { env } = scrubEnv(process.env, { CODEX_HOME: home, NO_COLOR: '1' });
    const argv = [
      ...(this.options.command ?? ['codex']),
      'exec',
      '-',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-s',
      task.scope === 'write-repo' ? 'workspace-write' : 'read-only',
      '-m',
      this.options.model,
      '--output-schema',
      schemaFile,
      '-o',
      outFile,
      '-C',
      task.cwd,
      '--color',
      'never',
    ];
    try {
      const result = await run(argv, { cwd: task.cwd, env, input: renderTask(task), timeoutMs: task.timeoutMs });
      const rawTail = tail(`${result.stdout}\n${result.stderr}`);
      if (result.error || result.timedOut || result.code !== 0 || !existsSync(outFile)) {
        const why = result.error ?? (result.timedOut ? 'timed out' : `exit ${result.code}`);
        const detail = rawTail.split('\n').reverse().find((l) => /^ERROR|error/.test(l)) ?? '';
        return { ok: false, errors: [`codex ${why}: ${detail.slice(0, 300)}`], rawTail, durationMs: Date.now() - started, attempts: 1 };
      }
      let output: unknown;
      try {
        output = JSON.parse(readFileSync(outFile, 'utf8'));
      } catch (err) {
        return { ok: false, errors: [`codex output is not JSON: ${(err as Error).message}`], rawTail, durationMs: Date.now() - started, attempts: 1 };
      }
      const problems = validate(task.outputSchema, output);
      return problems.length
        ? { ok: false, errors: [`schema: ${problems.slice(0, 5).join('; ')}`], rawTail, durationMs: Date.now() - started, attempts: 1 }
        : { ok: true, output, errors: [], rawTail, durationMs: Date.now() - started, attempts: 1 };
    } finally {
      // The login copy must not outlive the task.
      rmSync(join(home, 'auth.json'), { force: true });
    }
  }
}
