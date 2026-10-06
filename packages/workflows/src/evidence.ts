import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { EnvSpec } from '@gatehouse/env';
import { parseSurefireXml } from '@gatehouse/env';
import type { ExecutionTarget, Workspace } from '@gatehouse/targets';

/** What Testcontainers (and Docker clients generally) say when no daemon is reachable. */
export const NO_CONTAINER_RUNTIME = /Could not find a valid Docker environment|DockerClientProviderStrategy|Docker environment should have more than|Cannot connect to the Docker daemon/i;

export type ReproOutcome = 'RED' | 'GREEN' | 'INCONCLUSIVE';

export interface ReproRun {
  outcome: ReproOutcome;
  reason: string;
  durationMs: number;
}

const FQN = /^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*$/;

/**
 * Places an agent-written JUnit test next to the module that owns the cited file, runs it with
 * the repo's verified single-test command, and reads the result from the Surefire report —
 * never from the agent. The test file is removed afterwards.
 */
export async function runJavaRepro(
  target: ExecutionTarget,
  ws: Workspace,
  spec: EnvSpec,
  citedFile: string,
  testClass: string,
  testSource: string,
  timeoutMs: number,
): Promise<ReproRun> {
  const started = Date.now();
  const done = (outcome: ReproOutcome, reason: string): ReproRun => ({ outcome, reason, durationMs: Date.now() - started });
  if (!spec.commands.testOne) return done('INCONCLUSIVE', 'repo has no verified single-test command');
  if (!FQN.test(testClass)) return done('INCONCLUSIVE', `invalid test class name ${testClass}`);

  const moduleDir = owningModule(ws.dir, citedFile);
  const parts = testClass.split('.');
  const file = join(moduleDir, 'src', 'test', 'java', ...parts) + '.java';
  if (!resolve(file).startsWith(resolve(ws.dir) + sep)) return done('INCONCLUSIVE', 'test path escapes the workspace');
  if (existsSync(file)) return done('INCONCLUSIVE', `${testClass} already exists in the repo`);
  const report = join(moduleDir, 'target', 'surefire-reports', `TEST-${testClass}.xml`);
  rmSync(report, { force: true });

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, testSource);
  try {
    const argv = spec.commands.testOne.argv.map((a) => a.replace('{class}', testClass));
    const result = await target.exec(ws, argv, { timeoutMs });
    if (result.timedOut) return done('INCONCLUSIVE', 'repro timed out');
    if (!existsSync(report)) {
      const hint = `${result.stdout}\n${result.stderr}`.split('\n').find((l) => /COMPILATION ERROR|cannot find symbol|\[ERROR\].*\.java/.test(l));
      return done('INCONCLUSIVE', `test did not run${hint ? `: ${hint.trim().slice(0, 200)}` : ` (exit ${result.code})`}`);
    }
    const cases = parseSurefireXml(readFileSync(report, 'utf8'));
    if (!cases.length) return done('INCONCLUSIVE', 'test class has no test cases');
    // A failure caused by the environment proves nothing about the code.
    if (cases.some((c) => c.status === 'failed' && NO_CONTAINER_RUNTIME.test(c.message ?? '')) || (NO_CONTAINER_RUNTIME.test(result.stdout) && cases.every((c) => c.status !== 'passed'))) {
      return done('INCONCLUSIVE', 'environment lacks a container runtime (Testcontainers); run on host or in a cell runtime that provides Docker');
    }
    if (cases.every((c) => c.status === 'skipped')) return done('INCONCLUSIVE', 'every test case was skipped');
    const failed = cases.filter((c) => c.status === 'failed');
    return failed.length
      ? done('RED', `${failed.length}/${cases.length} test(s) failed: ${failed.map((c) => c.id.split('#')[1]).join(', ')}`)
      : done('GREEN', `${cases.filter((c) => c.status === 'passed').length}/${cases.length} test(s) passed`);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Nearest directory above the cited file that has a pom.xml (multi-module builds). */
export function owningModule(root: string, file: string): string {
  let dir = dirname(resolve(root, file));
  const top = resolve(root);
  while (dir.startsWith(top)) {
    if (existsSync(join(dir, 'pom.xml'))) return dir;
    if (dir === top) break;
    dir = dirname(dir);
  }
  return top;
}
