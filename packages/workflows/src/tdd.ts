import { join } from 'node:path';
import type { StepRunner } from '@gatehouse/engine';
import { readSurefireReports, type EnvSpec } from '@gatehouse/env';
import type { ExecutorAdapter } from '@gatehouse/harness';
import type { ExecutionTarget, Workspace } from '@gatehouse/targets';
import { changedPaths, commitAll, isProtectedPath, isTestPath, revertPaths, tailLines } from './pipeline.ts';
import type { AgentSpec } from './registry.ts';
import { fill } from './registry.ts';

export type TestOutcome = 'RED' | 'GREEN' | 'NO_RUN';

export interface ClassRun {
  outcome: TestOutcome;
  tail: string;
  failed: string[];
  durationMs: number;
}

/** Runs one test class with the repo's verified single-test command; the verdict comes from reports, not the agent. */
export async function runTestClass(target: ExecutionTarget, ws: Workspace, spec: EnvSpec, testClass: string, timeoutMs: number): Promise<ClassRun> {
  if (!spec.commands.testOne) return { outcome: 'NO_RUN', tail: 'no single-test command in the env spec', failed: [], durationMs: 0 };
  const argv = spec.commands.testOne.argv.map((a) => a.replace('{class}', testClass).replace('{file}', testClass));
  const r = await target.exec(ws, argv, { timeoutMs });
  const tail = tailLines(`${r.stdout}\n${r.stderr}`, 40);
  if (spec.stack !== 'java-maven') return { outcome: r.code === 0 ? 'GREEN' : 'RED', tail, failed: [], durationMs: r.durationMs };
  const simple = testClass.split('.').pop()!;
  const cases = readSurefireReports(ws.dir).filter((c) => c.className === testClass || c.className.endsWith(`.${simple}`));
  if (!cases.length) return { outcome: r.code === 0 ? 'NO_RUN' : 'RED', tail, failed: ['(did not compile or run)'], durationMs: r.durationMs };
  const failed = cases.filter((c) => c.status === 'failed').map((c) => c.id);
  return { outcome: failed.length ? 'RED' : 'GREEN', tail, failed, durationMs: r.durationMs };
}

export interface TddTask {
  id: string;
  title: string;
  testClass: string;
  /** Rendered task description, scenarios and context for the prompts (already enveloped). */
  task: string;
  scenarios: string;
  context: string;
}

export interface TaskLog {
  task: string;
  testClass: string;
  red: { outcome: TestOutcome; attempts: number; note?: string };
  green: { outcome: TestOutcome; attempts: number };
  reverted: string[];
  commits: string[];
}

export interface TddOptions {
  runner: StepRunner;
  target: ExecutionTarget;
  ws: Workspace;
  env: EnvSpec;
  agent: ExecutorAdapter;
  testWriter: AgentSpec;
  implementer: AgentSpec;
  runId: string;
  runDir: string;
  tier: string;
  timeoutMs: number;
  /** Legacy characterization tests must pass on unchanged code: GREEN is the goal of the test phase. */
  mode: 'red-green' | 'characterize';
  log: (line: string) => void;
}

/**
 * One test-first cycle with trusted code holding the loop: the agent only edits files; Gatehouse
 * reverts anything outside its allowance, runs the test, and decides RED/GREEN from the report.
 */
export async function tddCycle(t: TddTask, o: TddOptions): Promise<TaskLog> {
  const log: TaskLog = { task: t.id, testClass: t.testClass, red: { outcome: 'NO_RUN', attempts: 0 }, green: { outcome: 'NO_RUN', attempts: 0 }, reverted: [], commits: [] };
  const agentRun = async (spec: AgentSpec, phase: string, values: Record<string, string>, attempt: number) => {
    const r = await o.agent.run({
      runId: o.runId,
      stepId: `${phase}-${t.id}-${attempt}`,
      instructions: fill(spec.prompt, values),
      outputSchema: spec.schema,
      scope: 'write-repo',
      cwd: o.ws.dir,
      stateDir: join(o.runDir, 'agents', `${phase}-${t.id}-${attempt}`),
      tier: o.tier,
      timeoutMs: o.timeoutMs,
    });
    o.runner.emit('AGENT_RUN', { step: `${phase}-${t.id}`, executor: o.agent.id, agentVersion: spec.version, ok: r.ok, attempts: r.attempts, durationMs: r.durationMs, errors: r.errors.slice(0, 3) });
    return r;
  };
  const enforce = async (allowed: (p: string) => boolean) => {
    const bad = (await changedPaths(o.ws.dir)).filter((p) => !p.startsWith('.gatehouse/') && (!allowed(p) || isProtectedPath(p)));
    if (bad.length) {
      await revertPaths(o.ws.dir, bad);
      log.reverted.push(...bad);
      o.runner.emit('CHANGES_REVERTED', { task: t.id, paths: bad });
    }
  };

  // Test phase.
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    log.red.attempts = attempt;
    await agentRun(o.testWriter, 'test', { taskId: t.id, task: t.task, scenarios: t.scenarios, context: t.context, testClass: t.testClass, feedback }, attempt);
    await enforce(isTestPath);
    if (!(await changedPaths(o.ws.dir)).some((p) => isTestPath(p) && !p.startsWith('.gatehouse/'))) {
      feedback = '\n## Previous attempt\nNo test file was written or changed. Write the test class now.';
      continue;
    }
    const run = await runTestClass(o.target, o.ws, o.env, t.testClass, o.timeoutMs);
    log.red.outcome = run.outcome;
    o.log(`    ${t.id} test: ${run.outcome}`);
    const wanted = o.mode === 'red-green' ? run.outcome === 'RED' : run.outcome === 'GREEN';
    if (wanted) break;
    feedback =
      o.mode === 'red-green'
        ? `\n## Previous attempt\nThe test ${run.outcome === 'GREEN' ? 'already passes on the current code, so it does not capture the missing behaviour' : 'did not run'}. Rewrite it so it fails for the reason the scenario describes.\n\`\`\`\n${run.tail}\n\`\`\``
        : `\n## Previous attempt\nThe characterization test must pass on the current, unchanged code but it ${run.outcome === 'RED' ? 'fails' : 'did not run'}. Fix the test (not the code). If the code really behaves differently from what you expected, assert the actual behaviour and mention it in notes.\n\`\`\`\n${run.tail}\n\`\`\``;
  }
  if (o.mode === 'red-green' && log.red.outcome === 'GREEN') log.red.note = 'test passed before implementation (did not fail first)';
  if ((await changedPaths(o.ws.dir)).some((p) => !p.startsWith('.gatehouse/'))) {
    log.commits.push(await commitAll(o.ws.dir, `${t.id}: ${o.mode === 'red-green' ? 'failing test' : 'characterization test'} (${t.testClass})`));
  }
  if (o.mode === 'characterize') {
    log.green = { outcome: log.red.outcome, attempts: 0 };
    return log;
  }

  // Implementation phase.
  feedback = '';
  let last = await runTestClass(o.target, o.ws, o.env, t.testClass, o.timeoutMs);
  for (let attempt = 1; attempt <= 3 && last.outcome !== 'GREEN'; attempt++) {
    log.green.attempts = attempt;
    await agentRun(o.implementer, 'implement', { taskId: t.id, task: t.task, testClass: t.testClass, testOutput: `\`\`\`\n${last.tail}\n\`\`\``, context: t.context, feedback }, attempt);
    await enforce((p) => !isTestPath(p));
    last = await runTestClass(o.target, o.ws, o.env, t.testClass, o.timeoutMs);
    o.log(`    ${t.id} implement attempt ${attempt}: ${last.outcome}`);
    feedback = `\n## Previous attempt\nThe test still does not pass.`;
  }
  log.green.outcome = last.outcome;
  if ((await changedPaths(o.ws.dir)).some((p) => !p.startsWith('.gatehouse/'))) log.commits.push(await commitAll(o.ws.dir, `${t.id}: ${t.title}`));
  return log;
}
