import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ArtifactStore, EventStore, loadConfig, type RepoRecord } from '@gatehouse/core';
import type { EnvSpec } from '@gatehouse/env';
import { AwaitingGate } from '@gatehouse/gates';
import type { AgentResult, AgentTask, ExecutorAdapter } from '@gatehouse/harness';
import { HostTarget, createMirror, git, type ExecutionTarget, type RunResult, type Workspace } from '@gatehouse/targets';
import { runTicket, validatePbi, type PbiManifest } from '../src/index.ts';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const TICKET = 'Orders under 100.00 pay a flat shipping fee of 5.99. Orders at or above 100.00 ship free.';

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

async function repoFixture(root: string) {
  const src = join(root, 'src');
  write(src, 'pom.xml', '<project/>');
  write(src, 'AGENTS.md', 'repo instructions');
  write(src, 'src/main/java/app/Pricing.java', 'package app;\nclass Pricing {\n  double shipping(double total) { return 0; }\n}\n');
  await git(['init', '-q', '-b', 'main'], { cwd: src });
  await git(['add', '.'], { cwd: src });
  await git(['commit', '-qm', 'base'], { cwd: src, env: gitEnv });
  const mirror = join(root, 'mirror.git');
  await createMirror(src, mirror);
  return mirror;
}

/** Pretends to be Maven: a test passes once Pricing.java contains the fee rule. */
class FakeMavenTarget implements ExecutionTarget {
  readonly kind = 'host' as const;
  runs: string[][] = [];
  constructor(private readonly host: HostTarget) {}
  prepare(r: Parameters<ExecutionTarget['prepare']>[0]) {
    return this.host.prepare(r);
  }
  destroy(ws: Workspace) {
    return this.host.destroy(ws);
  }
  async exec(ws: Workspace, argv: string[]): Promise<RunResult> {
    this.runs.push(argv);
    const cls = argv.find((a) => a.startsWith('-Dtest='))?.slice(7) ?? 'app.PricingTest';
    const testFile = join(ws.dir, 'src/test/java', ...cls.split('.')) + '.java';
    const reports = join(ws.dir, 'target/surefire-reports');
    mkdirSync(reports, { recursive: true });
    if (existsSync(testFile)) {
      const fixed = readFileSync(join(ws.dir, 'src/main/java/app/Pricing.java'), 'utf8').includes('5.99');
      const body = fixed ? '' : '<failure message="expected 5.99"/>';
      writeFileSync(join(reports, `TEST-${cls}.xml`), `<testsuite><testcase name="chargesFee" classname="${cls}">${body}</testcase></testsuite>`);
    }
    return { argv, code: 0, signal: null, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  }
}

class FakeAuthor implements ExecutorAdapter {
  readonly id = 'copilot' as const;
  readonly route = 'gateway' as const;
  pbiCalls = 0;
  async run(task: AgentTask): Promise<AgentResult> {
    const ok = (output: unknown): AgentResult => ({ ok: true, output, errors: [], rawTail: '', durationMs: 1, attempts: 1 });
    const id = task.stepId.replace(/-retry$/, '');
    if (id === 'pbi') {
      this.pbiCalls++;
      // First attempt cites text that is not in the ticket; validation must reject it.
      const quote = this.pbiCalls === 1 ? 'shipping is always free' : 'flat shipping fee of 5.99';
      return ok({
        title: 'Flat shipping fee', problem: 'Charge shipping below the threshold', actors: ['shopper'],
        decision_variables: [{ name: 'order total', values: ['< 100.00', '>= 100.00'] }],
        acceptance_criteria: [{ id: 'AC1', text: 'Orders under 100.00 pay 5.99', kind: 'SOURCE', source_quote: quote }],
        business_matrix: [{ id: 'M1', conditions: 'total 99.99', expected: 'fee 5.99', kind: 'boundary', covers: ['AC1'] }],
        scenarios: [{ id: 'SC1', given: 'total 50', when: 'shipping computed', then: 'fee is 5.99', covers: ['AC1'] }],
        open_questions: [],
      });
    }
    if (id === 'spec') return ok({ overview: 'o', functional_requirements: [{ id: 'FR1', text: 'fee', traces: ['AC1'] }], non_functional: [], affected_components: [{ path: 'src/main/java/app/Pricing.java', reason: 'rule', is_new: false }], data_changes: [], api_changes: [], out_of_scope: [] });
    if (id === 'plan') return ok({ approach: 'a', steps: [{ id: 'P1', description: 'add fee', files: [{ path: 'src/main/java/app/Pricing.java', change: 'modify' }], traces: ['FR1'] }], test_strategy: [{ scenario_id: 'SC1', test_class: 'app.PricingTest', kind: 'unit' }], risks: [] });
    if (id === 'tasks') return ok({ tasks: [{ id: 'T1', title: 'flat fee', step_ids: ['P1'], files: ['src/main/java/app/Pricing.java'], test_class: 'app.PricingTest', scenario_ids: ['SC1'], depends_on: [] }] });
    if (id.startsWith('test-T1')) {
      write(task.cwd, 'src/test/java/app/PricingTest.java', 'package app;\nclass PricingTest { @Test void chargesFee() { assertEquals(5.99, new Pricing().shipping(50)); } }\n');
      write(task.cwd, 'pom.xml', '<project><!-- sneaky dependency --></project>');
      return ok({ summary: 'test', files_changed: [], notes: '' });
    }
    if (id.startsWith('implement-T1')) {
      write(task.cwd, 'src/main/java/app/Pricing.java', 'package app;\nclass Pricing {\n  double shipping(double total) { return total < 100.00 ? 5.99 : 0; }\n}\n');
      return ok({ summary: 'impl', files_changed: [], notes: '' });
    }
    if (id === 'quarantine-read') return ok({ summary: 's', acceptance_criteria: [], risks: [], open_questions: [] });
    const hunks = /must be exactly: ([H\d, ]+)\./.exec(task.instructions)?.[1]?.split(', ') ?? [];
    return ok({ reviewed_hunks: hunks, findings: [] });
  }
}

test('pbi validation rejects quotes that are not in the ticket and unanswered inferred criteria', () => {
  const m: PbiManifest = {
    title: 't', problem: 'p', actors: [], decision_variables: [], open_questions: [],
    acceptance_criteria: [{ id: 'AC1', text: 'x', kind: 'SOURCE', source_quote: 'not in ticket' }, { id: 'AC2', text: 'y', kind: 'INFERRED', source_quote: '' }],
    business_matrix: [{ id: 'M1', conditions: 'c', expected: 'e', kind: 'positive', covers: ['AC1'] }],
    scenarios: [{ id: 'SC1', given: 'g', when: 'w', then: 't', covers: ['AC1', 'AC9'] }],
  };
  const problems = validatePbi(m, TICKET).join('\n');
  assert.match(problems, /AC1 is SOURCE but its source_quote is not found verbatim/);
  assert.match(problems, /AC2 is INFERRED: add an open question/);
  assert.match(problems, /AC2 is not covered by any scenario/);
  assert.match(problems, /SC1 covers unknown AC9/);
});

test('ticket pipeline: gates stop and resume, test-first implementation, protected files reverted, reviewed patch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-tkt-'));
  try {
    const mirror = await repoFixture(root);
    const { config } = loadConfig({ env: { GATEHOUSE_HOME: join(root, 'home') } });
    const events = new EventStore(':memory:');
    const artifacts = new ArtifactStore(join(root, 'artifacts'));
    const repo: RepoRecord = { name: 'shop', source: 'https://github.com/o/shop.git', mirror, defaultBranch: 'main', pciScope: 'out', addedAt: '' };
    const runsDir = join(root, 'runs');
    const target = new FakeMavenTarget(new HostTarget({ runsDir, mirrorFor: () => mirror }));
    const author = new FakeAuthor();
    const envSpec = { stack: 'java-maven', commands: { testOne: { argv: ['mvn', 'test', '-Dtest={class}'] }, testAll: { argv: ['mvn', 'test'] } }, toolchain: {} } as unknown as EnvSpec;
    const approved = new Set<string>();
    const ticketArtifact = artifacts.put('ticket.source', TICKET, 'text/markdown').hash;
    let reviewed: { base: string; head: string } | null = null;
    const deps = {
      config, events, artifacts, repo, target, runsDir, author, critic: null,
      env: { level: 'L2', spec: envSpec, approved: true, baseline: { tool: 'surefire' as const, tests: {}, summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 } } },
      awaitGate: async (gate: string, artifact: string) => {
        if (!approved.has(gate)) throw new AwaitingGate(gate, artifact);
      },
      review: async (o: { base: string; head: string }) => {
        reviewed = o;
        return { packageHash: artifacts.putJson('pr.review.package', { ok: true }).hash, summaryPath: '', postable: 0 };
      },
    };
    const input = { runId: 'tkt-1', ticketKey: 'SHOP-7', ticketArtifact };

    await assert.rejects(runTicket(deps, input), (e: unknown) => e instanceof AwaitingGate && e.gate === 'GATE_1');
    assert.equal(author.pbiCalls, 2, 'the invented quote was rejected and the stage retried once');
    for (const g of ['GATE_1', 'GATE_2', 'GATE_3']) {
      approved.add(g);
      await assert.rejects(runTicket(deps, input), (e: unknown) => e instanceof AwaitingGate);
    }
    approved.add('GATE_4');
    const pkg = await runTicket(deps, input);

    assert.equal(pkg.tasks[0]!.red.outcome, 'RED', 'the test failed before the implementation');
    assert.equal(pkg.tasks[0]!.green.outcome, 'GREEN');
    assert.deepEqual(pkg.tasks[0]!.reverted, ['pom.xml']);
    assert.equal(pkg.branch.startsWith('gatehouse/shop-7-'), true);
    assert.equal(await git(['-C', mirror, 'rev-parse', `refs/gatehouse/runs/tkt-1`]), pkg.head);
    const files = await git(['-C', mirror, 'diff', '--name-only', pkg.base, pkg.head]);
    assert.deepEqual(files.split('\n').sort(), ['src/main/java/app/Pricing.java', 'src/test/java/app/PricingTest.java'], 'masked AGENTS.md and the reverted pom.xml never reach the commit');
    assert.deepEqual(reviewed, { base: pkg.base, head: 'refs/gatehouse/runs/tkt-1', title: 'SHOP-7: Flat shipping fee', body: reviewed!['body' as never] });
    assert.ok(events.list('tkt-1').some((e) => e.type === 'AWAITING_GATE' && (e.payload as { gate: string }).gate === 'GATE_5'));
    assert.equal(events.verify('tkt-1').ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
