import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ArtifactStore, EventStore, loadConfig, type RepoRecord } from '@gatehouse/core';
import type { EnvSpec } from '@gatehouse/env';
import type { AgentResult, AgentTask, ExecutorAdapter } from '@gatehouse/harness';
import { HostTarget, createMirror, git, type ExecutionTarget, type RunResult, type Workspace } from '@gatehouse/targets';
import { readJacoco, runLegacyTests } from '../src/index.ts';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const jacoco = (covered: number) => `<?xml version="1.0"?><report name="x"><package name="app"><class name="app/Discount" sourcefilename="Discount.java"><method name="rate" desc="()D" line="3"><counter type="LINE" missed="1" covered="1"/></method><counter type="LINE" missed="${20 - covered}" covered="${covered}"/><counter type="BRANCH" missed="${4 - Math.min(4, covered / 5)}" covered="${Math.min(4, covered / 5)}"/></class><class name="app/Discount$Inner" sourcefilename="Discount.java"><counter type="LINE" missed="5" covered="0"/></class></package></report>`;

class FakeCoverageTarget implements ExecutionTarget {
  readonly kind = 'host' as const;
  constructor(private readonly host: HostTarget) {}
  prepare(r: Parameters<ExecutionTarget['prepare']>[0]) {
    return this.host.prepare(r);
  }
  destroy(ws: Workspace) {
    return this.host.destroy(ws);
  }
  async exec(ws: Workspace, argv: string[]): Promise<RunResult> {
    const hasTest = existsSync(join(ws.dir, 'src/test/java/app/DiscountGatehouseTest.java'));
    write(ws.dir, 'target/site/jacoco/jacoco.xml', jacoco(hasTest ? 18 : 2));
    if (argv.some((a) => a.startsWith('-Dtest=')) && hasTest) {
      write(ws.dir, 'target/surefire-reports/TEST-app.DiscountGatehouseTest.xml', '<testsuite><testcase name="a" classname="app.DiscountGatehouseTest"/><testcase name="b" classname="app.DiscountGatehouseTest"/></testsuite>');
    }
    return { argv, code: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  }
}

class FakeAuthor implements ExecutorAdapter {
  readonly id = 'copilot' as const;
  readonly route = 'gateway' as const;
  async run(task: AgentTask): Promise<AgentResult> {
    const ok = (output: unknown): AgentResult => ({ ok: true, output, errors: [], rawTail: '', durationMs: 1, attempts: 1 });
    if (task.stepId.startsWith('triage')) return ok({ backlog: [{ class_name: 'app.Discount', reason: 'pricing rule', priority: 'high', risk: 'wrong discounts' }] });
    if (task.stepId.startsWith('charter')) {
      return ok({
        charters: [{
          class_name: 'app.Discount', test_class: 'app.DiscountGatehouseTest', fixtures_reused: [],
          scenarios: [
            { id: 'SCN-1', method: 'rate', given: 'gold customer', when: 'rate()', then: '0.1', kind: 'happy' },
            { id: 'SCN-2', method: 'rate', given: 'no tier', when: 'rate()', then: '0', kind: 'negative' },
          ],
        }],
      });
    }
    if (task.stepId.startsWith('test-C1')) {
      write(task.cwd, 'src/test/java/app/DiscountGatehouseTest.java', 'class DiscountGatehouseTest { void a() { assertEquals(0.1, new Discount().rate()); } }');
      write(task.cwd, 'src/main/java/app/Discount.java', 'tampered production code');
      return ok({ summary: 's', files_changed: [], notes: '' });
    }
    return ok({ issues: [] });
  }
}

test('JaCoCo parsing keeps class-level counters and folds inner classes away', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-jacoco-'));
  try {
    write(dir, 'target/site/jacoco/jacoco.xml', jacoco(5));
    write(dir, 'src/main/java/app/Discount.java', 'x');
    const [c] = readJacoco(dir);
    assert.deepEqual({ ...c }, { className: 'app.Discount', sourceFile: 'Discount.java', path: 'src/main/java/app/Discount.java', lineMissed: 15, lineCovered: 5, branchMissed: 3, branchCovered: 1, methods: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy pipeline: measured coverage delta, test-only changes, characterization tests pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-lgt-'));
  try {
    const src = join(root, 'src');
    write(src, 'src/main/java/app/Discount.java', 'package app; class Discount { double rate() { return 0.1; } }');
    await git(['init', '-q', '-b', 'main'], { cwd: src });
    await git(['add', '.'], { cwd: src });
    await git(['commit', '-qm', 'base'], { cwd: src, env: gitEnv });
    const mirror = join(root, 'mirror.git');
    await createMirror(src, mirror);
    const { config } = loadConfig({ env: { GATEHOUSE_HOME: join(root, 'home') } });
    const events = new EventStore(':memory:');
    const artifacts = new ArtifactStore(join(root, 'artifacts'));
    const repo: RepoRecord = { name: 'shop', source: 'https://github.com/o/shop.git', mirror, defaultBranch: 'main', pciScope: 'out', addedAt: '' };
    const runsDir = join(root, 'runs');
    const envSpec = { stack: 'java-maven', toolchain: {}, commands: { testOne: { argv: ['mvn', 'test', '-Dtest={class}'] }, coverage: { argv: ['mvn', 'jacoco'] } } } as unknown as EnvSpec;
    const pkg = await runLegacyTests(
      {
        config, events, artifacts, repo, runsDir, author: new FakeAuthor(), critic: null,
        target: new FakeCoverageTarget(new HostTarget({ runsDir, mirrorFor: () => mirror })),
        env: { level: 'L2', spec: envSpec, approved: true },
        awaitGate: async () => undefined,
      },
      { runId: 'lgt-1' },
    );
    const t = pkg.targets[0]!;
    assert.equal(t.className, 'app.Discount');
    assert.deepEqual([t.before.line, t.after.line], [10, 90]);
    assert.equal(t.status, 'GREEN');
    assert.deepEqual(t.reverted, ['src/main/java/app/Discount.java'], 'the production change was reverted');
    const files = await git(['-C', mirror, 'diff', '--name-only', pkg.base, pkg.head]);
    assert.equal(files, 'src/test/java/app/DiscountGatehouseTest.java');
    assert.ok(events.list('lgt-1').some((e) => e.type === 'AWAITING_GATE' && (e.payload as { gate: string }).gate === 'GATE_4'));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
