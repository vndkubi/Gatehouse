import type { ExecutionTarget, RunResult, Workspace } from '@gatehouse/targets';
import type { Command, EnvSpec } from './spec.ts';
import { readSurefireReports, type TestResult } from './surefire.ts';

export type EnvLevel = 'L0' | 'L1' | 'L2';

export interface VerifyStep {
  name: 'setup' | 'build' | 'testAll' | 'testOne' | 'rerunFailed';
  argv: string[];
  code: number | null;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  outputTail: string;
}

export interface Baseline {
  tool: 'surefire' | 'exit-code';
  /** Test id -> status after one rerun of failures; `flaky` = failed, then passed on rerun. */
  tests: Record<string, 'passed' | 'failed' | 'skipped' | 'flaky'>;
  summary: { total: number; passed: number; failed: number; skipped: number; flaky: number };
}

export interface VerifyReport {
  level: EnvLevel;
  steps: VerifyStep[];
  baseline?: Baseline;
  /** Why the next level was not reached. */
  reasons: string[];
}

export interface VerifyOptions {
  maxLevel?: EnvLevel;
  stepTimeoutMs?: number;
  onStep?: (step: VerifyStep) => void;
}

const MAX_RERUN_CLASSES = 20;

/**
 * Proves the spec by running it: L1 = setup + build succeed; L2 = the test suite runs to a
 * recorded baseline and the single-test slot works. Failing tests do not block L2 — they are
 * recorded so later repro runs are never confused by pre-existing failures.
 */
export async function verifyEnv(target: ExecutionTarget, ws: Workspace, spec: EnvSpec, options: VerifyOptions = {}): Promise<VerifyReport> {
  const steps: VerifyStep[] = [];
  const reasons: string[] = [];
  const maxLevel = options.maxLevel ?? 'L2';
  const timeoutMs = options.stepTimeoutMs ?? 30 * 60_000;

  const exec = async (name: VerifyStep['name'], command: Command, substitutions: Record<string, string> = {}) => {
    const argv = command.argv.map((a) => a.replace(/\{(class|file)\}/g, (_, k: string) => substitutions[k] ?? `{${k}}`));
    const result = await target.exec(ws, argv, { timeoutMs });
    const step = toStep(name, argv, result);
    steps.push(step);
    options.onStep?.(step);
    return step;
  };
  const ok = (s: VerifyStep) => s.code === 0 && !s.timedOut && !s.error;

  if (spec.commands.setup) {
    const s = await exec('setup', spec.commands.setup);
    if (!ok(s)) return { level: 'L0', steps, reasons: [`setup failed: ${summarize(s)}`] };
  }
  if (!spec.commands.build && !spec.commands.setup) {
    return { level: 'L0', steps, reasons: ['spec has no build command'] };
  }
  if (spec.commands.build) {
    const s = await exec('build', spec.commands.build);
    if (!ok(s)) return { level: 'L0', steps, reasons: [`build failed: ${summarize(s)}`] };
  }
  if (maxLevel === 'L1') return { level: 'L1', steps, reasons: ['stopped at L1 by request'] };
  if (!spec.commands.testAll) return { level: 'L1', steps, reasons: ['spec has no test command'] };

  const all = await exec('testAll', spec.commands.testAll);
  if (all.timedOut || all.error) return { level: 'L1', steps, reasons: [`test run did not complete: ${summarize(all)}`] };

  if (spec.stack !== 'java-maven') {
    if (!ok(all)) return { level: 'L1', steps, reasons: [`test command failed: ${summarize(all)}`] };
    return { level: 'L2', steps, baseline: { tool: 'exit-code', tests: {}, summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 } }, reasons };
  }

  const first = readSurefireReports(ws.dir);
  if (!first.length) return { level: 'L1', steps, reasons: [`no Surefire reports were produced: ${summarize(all)}`] };

  const tests: Baseline['tests'] = Object.fromEntries(first.map((t) => [t.id, t.status]));
  const failedClasses = [...new Set(first.filter((t) => t.status === 'failed').map((t) => t.className))];
  if (failedClasses.length && spec.commands.testOne) {
    const rerun = failedClasses.slice(0, MAX_RERUN_CLASSES);
    await exec('rerunFailed', spec.commands.testOne, { class: rerun.join(',') });
    const again = new Map(readSurefireReports(ws.dir).map((t) => [t.id, t] as const));
    for (const t of first) {
      if (t.status === 'failed' && again.get(t.id)?.status === 'passed') tests[t.id] = 'flaky';
    }
    if (failedClasses.length > MAX_RERUN_CLASSES) reasons.push(`only the first ${MAX_RERUN_CLASSES} failing classes were re-run for flakiness`);
  }
  const baseline = toBaseline(tests);

  // The repro slot must work on its own, otherwise evidence steps cannot run.
  const probe = pickPassingClass(first);
  if (!spec.commands.testOne) return { level: 'L1', steps, baseline, reasons: ['spec has no single-test command'] };
  if (!probe) return { level: 'L1', steps, baseline, reasons: ['no passing test class to validate the single-test command'] };
  const one = await exec('testOne', spec.commands.testOne, { class: probe });
  if (!ok(one)) return { level: 'L1', steps, baseline, reasons: [`single-test command failed for ${probe}: ${summarize(one)}`] };

  return { level: 'L2', steps, baseline, reasons };
}

function pickPassingClass(results: TestResult[]): string | undefined {
  const failing = new Set(results.filter((r) => r.status !== 'passed').map((r) => r.className));
  return results.map((r) => r.className).find((c) => !failing.has(c));
}

function toBaseline(tests: Baseline['tests']): Baseline {
  const values = Object.values(tests);
  const count = (s: string) => values.filter((v) => v === s).length;
  return {
    tool: 'surefire',
    tests,
    summary: { total: values.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), flaky: count('flaky') },
  };
}

function toStep(name: VerifyStep['name'], argv: string[], r: RunResult): VerifyStep {
  const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-40).join('\n');
  return {
    name,
    argv,
    code: r.code,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
    ...(r.error ? { error: r.error } : {}),
    outputTail: tail,
  };
}

function summarize(s: VerifyStep): string {
  if (s.error) return s.error;
  if (s.timedOut) return 'timed out';
  const lines = s.outputTail.split('\n');
  // Maven ends with boilerplate ([Help 1], "Re-run Maven ..."); the first real [ERROR] line is the cause.
  const boilerplate = /^\[ERROR\]\s*($|To see|Re-run|For more|\[Help|->)/;
  const hint =
    lines.find((l) => /^\[ERROR\]/.test(l) && !boilerplate.test(l)) ??
    [...lines].reverse().find((l) => /ERROR|error|FAIL|Exception/.test(l) && !boilerplate.test(l));
  return `exit ${s.code}${hint ? ` — ${hint.trim().slice(0, 200)}` : ''}`;
}
