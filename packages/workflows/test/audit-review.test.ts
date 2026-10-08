import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtifactStore, EventStore, loadConfig, type RepoRecord } from '@gatehouse/core';
import type { AgentResult, AgentTask, ExecutorAdapter, StructuredCaller, StructuredRequest, StructuredResult } from '@gatehouse/harness';
import { HostTarget, createMirror, git, type ExecutionTarget, type RunResult, type Workspace } from '@gatehouse/targets';
import { armMetrics, compareArms, renderComparison, runPrReview, type AuditAnswer, type ReviewArm, type ReviewPackage } from '../src/index.ts';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const BFF_BASE = `package app;
class OrderBff {
  private final PaymentClient payments;
  OrderBff(PaymentClient p) { this.payments = p; }
  void pay(String orderId, long amountCents) {
    if (amountCents <= 0) throw new IllegalArgumentException("amount");
    payments.charge(orderId, amountCents);
  }
}
`;
// The PR drops the BFF's check; whether the payment service validates is in its contract.
const BFF_HEAD = `package app;
class OrderBff {
  private final PaymentClient payments;
  OrderBff(PaymentClient p) { this.payments = p; }
  void pay(String orderId, long amountCents) {
    payments.charge(orderId, amountCents);
  }
}
`;
const CLIENT = `package app;
@FeignClient(name = "payment-service")
interface PaymentClient {
  /** Rejects amounts <= 0 with HTTP 422. */
  void charge(String orderId, long amountCents);
}
`;

async function fixture(root: string) {
  const src = join(root, 'src');
  mkdirSync(join(src, 'app'), { recursive: true });
  await git(['init', '-q', '-b', 'main'], { cwd: src });
  writeFileSync(join(src, 'app', 'OrderBff.java'), BFF_BASE);
  writeFileSync(join(src, 'app', 'PaymentClient.java'), CLIENT);
  await git(['add', '.'], { cwd: src });
  await git(['commit', '-qm', 'base'], { cwd: src, env: gitEnv });
  const base = await git(['rev-parse', 'HEAD'], { cwd: src });
  await git(['checkout', '-qb', 'feature'], { cwd: src });
  writeFileSync(join(src, 'app', 'OrderBff.java'), BFF_HEAD);
  mkdirSync(join(src, 'specs', '001-pay', 'checklists'), { recursive: true });
  writeFileSync(join(src, 'specs', '001-pay', 'checklists', 'business.md'), '# Business\n- [ ] CHK001 A payment amount must be positive before it is charged\n');
  await git(['add', '.'], { cwd: src });
  await git(['commit', '-qm', 'feature'], { cwd: src, env: gitEnv });
  const head = await git(['rev-parse', 'HEAD'], { cwd: src });
  await git(['checkout', '-q', 'main'], { cwd: src });
  const mirror = join(root, 'mirror.git');
  await createMirror(src, mirror);
  return { mirror, base, head };
}

const ok = (output: unknown): AgentResult => ({ ok: true, output, errors: [], rawTail: '', durationMs: 1, attempts: 1 });

/** Copilot stand-in: quarantine reader, arm A unit reviewers, the context investigator. */
class FakeReviewer implements ExecutorAdapter {
  readonly id = 'copilot' as const;
  readonly route = 'gateway' as const;
  tasks: AgentTask[] = [];
  async run(task: AgentTask): Promise<AgentResult> {
    this.tasks.push(task);
    if (task.stepId === 'quarantine-read') return ok({ summary: 'Simplify pay', acceptance_criteria: [{ id: 'AC1', text: 'pay charges the order amount' }], risks: [], open_questions: [] });
    if (task.stepId.startsWith('lookup-')) return ok({ found: [], not_in_repo: ['payment-service validation lives in another repository'] });
    if (task.stepId.startsWith('verify-')) {
      // G1: a real assertion on the stated rule. G2: blows up in setup (a mock problem, not the defect).
      const g = task.stepId.slice(7);
      return ok({
        expected_source: { kind: 'rule', ref: 'business:CHK001', file: null, line: null, quote: null },
        reachability: 'POST /orders/{id}/pay with amount 0',
        test: { test_class: `app.${g}GatehouseReproTest`, test_source: g === 'G1' ? '// ASSERT rejects zero' : '// NPE in setup' },
        blocked_reason: null,
      });
    }
    if (task.stepId.startsWith('review-B')) return ok({ ac_status: [{ ac_id: 'AC1', status: 'implemented', evidence_hunks: ['H1'], note: '' }], findings: [] });
    const hunks = /must be exactly: ([H\d, ]+)\./.exec(task.instructions)?.[1]?.split(', ') ?? [];
    if (!task.stepId.startsWith('review-T')) return ok({ reviewed_hunks: hunks, findings: [] });
    assert.match(task.instructions, /Set `repro` to null for every finding/, 'arm A: repro comes from the shared verify step, not the reviewer');
    return ok({
      reviewed_hunks: hunks,
      findings: [{ title: 'Non-positive amounts are no longer rejected', severity: 'P1', category: 'validation', file: 'app/OrderBff.java', line: 6, evidence_quote: 'payments.charge(orderId, amountCents);', explanation: 'The check was removed.', failing_scenario: 'pay("o", 0) charges', suggested_fix: 'restore the check', repro: null }],
    });
  }
}

/** Single-pass stand-in: answers from the item ids in the tail, like a model that only sees the pack. */
class FakeStructured implements StructuredCaller {
  calls: StructuredRequest[] = [];
  constructor(private readonly techFails = false) {}
  async call(req: StructuredRequest): Promise<StructuredResult> {
    this.calls.push(req);
    const res = (output: unknown): StructuredResult => ({ ok: true, output, errors: [], attempts: 1, durationMs: 1, usage: { promptTokens: 1000, completionTokens: 100, cachedPromptTokens: this.calls.length > 1 ? 800 : 0 } });
    if (req.stepId.startsWith('fix-')) return res({ as_is: { file: 'app/OrderBff.java', line: 6, quote: 'payments.charge(orderId, amountCents);' }, to_be: 'if (amountCents <= 0) throw new IllegalArgumentException("amount");\npayments.charge(orderId, amountCents);', explanation: 'restores the guard' });
    const ids = /Answer exactly these items, once each: (.+)\.$/m.exec(req.tail)?.[1]?.split(', ') ?? [/item (\S+) only/.exec(req.tail)![1]!];
    const sawContract = req.tail.includes('Rejects amounts <= 0');
    return res({
      results: ids.map((id): AuditAnswer => {
        const a: AuditAnswer = { item_id: id, verdict: 'not_applicable', evidence: [], rationale: 'unrelated', missing_context: [], cross_service: 'none', requirement_issue: null, candidate: null };
        if ((id === 'T1.tech' || id === 'T2.tech') && this.techFails) {
          return {
            ...a,
            verdict: 'fail',
            candidate: { title: 'Zero amounts reach the payment service', severity: 'P1', class: 'technical', category: 'validation', invariant: 'amount must be positive before charging', entry_point: 'pay', cause: { file: 'app/OrderBff.java', line: 6, quote: 'payments.charge(orderId, amountCents);' }, failing_scenario: 'pay("o", 0) charges' },
          };
        }
        if (id === 'V-error-handling.2' && this.techFails) {
          return {
            ...a,
            verdict: 'fail',
            candidate: { title: 'Exception contract changed', severity: 'P2', class: 'technical', category: 'error-handling', invariant: 'callers rely on IllegalArgumentException', entry_point: 'OrderBff', cause: { file: 'app/OrderBff.java', line: 4, quote: 'OrderBff(PaymentClient p) { this.payments = p; }' }, failing_scenario: 'caller catches IllegalArgumentException' },
          };
        }
        if (id === 'T1.tech' || id === 'T2.tech') return { ...a, verdict: 'pass', evidence: [{ file: 'app/OrderBff.java', line: 6, quote: 'payments.charge(orderId, amountCents);' }] };
        if (id === 'T1.conv' || id === 'T2.conv') {
          return {
            ...a,
            verdict: 'fail',
            candidate: { title: 'Guard moved out of the BFF without a comment', severity: 'P4', class: 'convention', category: 'clean-code', invariant: 'removed guards are explained', entry_point: 'pay', cause: { file: 'app/OrderBff.java', line: 6, quote: 'payments.charge(orderId, amountCents);' }, failing_scenario: 'reader cannot tell where validation went' },
          };
        }
        if (id === 'business:CHK001') {
          if (sawContract) return { ...a, verdict: 'pass', rationale: 'payment-service rejects <= 0 by contract', evidence: [{ file: 'app/PaymentClient.java', line: 4, quote: 'Rejects amounts <= 0 with HTTP 422.' }], cross_service: 'affected' };
          return { ...a, verdict: 'cannot_determine', rationale: 'the BFF no longer checks; the downstream contract is not in the pack', missing_context: [{ need: 'contract', question: 'Does the payment service reject non-positive amounts?', lookup: ['PaymentClient'] }], cross_service: 'unknown' };
        }
        if (id === 'AC1') return { ...a, verdict: 'pass', evidence: [{ file: 'app/OrderBff.java', line: 6, quote: 'payments.charge(orderId, amountCents);' }] };
        return a;
      }),
    });
  }
}

/** Pretends to be Maven: "ASSERT" tests fail by assertion while the guard is missing; others error out. */
class FakeMaven implements ExecutionTarget {
  readonly kind = 'host' as const;
  runs: string[] = [];
  constructor(private readonly host: HostTarget) {}
  prepare(r: Parameters<ExecutionTarget['prepare']>[0]) {
    return this.host.prepare(r);
  }
  destroy(ws: Workspace) {
    return this.host.destroy(ws);
  }
  async exec(ws: Workspace, argv: string[]): Promise<RunResult> {
    const cls = argv.find((a) => a.startsWith('-Dtest='))!.slice(7);
    const src = join(ws.dir, 'src/test/java', ...cls.split('.')) + '.java';
    const guarded = readFileSync(join(ws.dir, 'app/OrderBff.java'), 'utf8').includes('amountCents <= 0');
    this.runs.push(`${cls}@${guarded ? 'base' : 'head'}`);
    const reports = join(ws.dir, 'target/surefire-reports');
    mkdirSync(reports, { recursive: true });
    if (existsSync(src)) {
      const body = readFileSync(src, 'utf8').includes('ASSERT') ? (guarded ? '' : '<failure message="expected IllegalArgumentException" type="org.opentest4j.AssertionFailedError"/>') : '<error message="NullPointerException" type="java.lang.NullPointerException"/>';
      writeFileSync(join(reports, `TEST-${cls}.xml`), `<testsuite><testcase name="rejectsZero" classname="${cls}">${body}</testcase></testsuite>`);
    }
    return { argv, code: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  }
}

async function runArm(arm: ReviewArm, opts: { withEnv?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `gh-arm${arm}-`));
  const { mirror } = await fixture(root);
  const { config } = loadConfig({ env: { GATEHOUSE_HOME: join(root, 'home') } });
  const events = new EventStore(':memory:');
  const artifacts = new ArtifactStore(join(root, 'artifacts'));
  const repo: RepoRecord = { name: 'shop', source: '', mirror, defaultBranch: 'main', pciScope: 'out', addedAt: '' };
  const runsDir = join(root, 'runs');
  const reviewer = new FakeReviewer();
  const structured = new FakeStructured(!!opts.withEnv);
  const host = new HostTarget({ runsDir, mirrorFor: () => mirror });
  if (opts.withEnv) {
    // An approved L2 environment, as `gatehouse env verify` + GATE_ENV would leave it.
    const spec = artifacts.put('env.spec', 'stack: java-maven\ncommands:\n  testOne: { argv: [mvn, test, "-Dtest={class}"] }\n', 'text/yaml', {}).hash;
    events.append('onboard-shop-1', 'ENV_VERIFIED', { level: 'L2', spec });
  }
  const deps = {
    config, events, artifacts, repo, runsDir,
    target: opts.withEnv ? new FakeMaven(host) : host,
    envApproved: async () => !!opts.withEnv,
    github: null,
    reviewer,
    critic: null,
    structured,
    usage: () => ({ calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null }),
  };
  const input = { runId: `prr${arm}-1`, source: { kind: 'refs' as const, base: 'main', head: 'feature', title: 'Simplify pay', body: '', label: 'shop: main...feature' }, arm };
  const result = await runPrReview(deps, input);
  const pkg = JSON.parse(artifacts.read(result.packageHash).toString('utf8')) as ReviewPackage;
  return { root, pkg, result, reviewer, structured, events, artifacts, deps, input };
}

test('arm B: fixed context; missing contract stays "not checked", never a pass; prompts are cache-ordered', async () => {
  const r = await runArm('B');
  try {
    const a = r.pkg.audit!;
    assert.equal(a.arm, 'B');
    const chk = a.items.find((i) => i.id === 'business:CHK001')!;
    assert.equal(chk.status, 'cannot_determine');
    assert.deepEqual(chk.routedFor, [], 'arm B does not investigate missing context');
    assert.match(readFileSync(r.result.summaryPath, 'utf8'), /Not checked — needs context or a person[\s\S]*business:CHK001/);

    // Cache order: every audit call shares the first prefix block; same-region batches share the pack.
    const audits = r.structured.calls.filter((c) => c.stepId.startsWith('audit-'));
    assert.ok(audits.length >= 2);
    assert.ok(audits.every((c) => c.prefix[0] === audits[0]!.prefix[0] && c.system === audits[0]!.system));
    const byRegion = new Map<string, string>();
    for (const c of audits) {
      const region = /## Context pack (\S+)/.exec(c.prefix[1]!)![1]!;
      if (byRegion.has(region)) assert.equal(c.prefix[1], byRegion.get(region));
      byRegion.set(region, c.prefix[1]!);
      assert.ok(c.tail.startsWith('## Batch'), 'the varying part is last');
      assert.doesNotMatch(c.tail, /Context pack/);
    }
    assert.ok([...byRegion.values()].some((p) => p.includes('http-client at app/OrderBff.java')), 'the pack names the service boundary');

    // The convention issue is explained and gets its AS-IS / TO-BE only after that.
    const conv = r.pkg.findings.find((f) => f.category.startsWith('convention'))!;
    assert.equal(conv.status, 'explained');
    assert.match(conv.suggested_fix, /^AS-IS `app\/OrderBff.java:6`/);
    assert.ok(r.structured.calls.findIndex((c) => c.stepId.startsWith('fix-')) > r.structured.calls.findIndex((c) => c.stepId.startsWith('audit-')));
    assert.equal(r.pkg.critic, 'none');
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('arm C: missing contract opens a bounded investigation that reads it and re-asks that item only', async () => {
  const r = await runArm('C');
  try {
    const a = r.pkg.audit!;
    const chk = a.items.find((i) => i.id === 'business:CHK001')!;
    assert.deepEqual(chk.routedFor, ['missing_context', 'cross_service_unknown']);
    assert.equal(chk.status, 'pass');
    assert.deepEqual(chk.history, ['audit:cannot_determine', 'expand#1:pass']);
    const expand = r.structured.calls.find((c) => c.stepId === 'expand-business:CHK001-1')!;
    assert.match(expand.tail, /app\/PaymentClient.java/, 'the deterministic lookup found the Feign contract');
    assert.equal(expand.prefix[0], r.structured.calls[0]!.prefix[0], 'the expansion keeps the shared prefix');
    const inv = a.investigations.find((i) => i.item === 'business:CHK001')!;
    assert.equal(inv.kind, 'expand');
    assert.equal(inv.agenticLookups, 0, 'no agent needed when the repo search found it');
    assert.ok(a.investigations.some((i) => i.kind === 'second-read'), 'high-risk or sampled passes get an independent read');
    assert.ok(!r.reviewer.tasks.some((t) => t.stepId.startsWith('lookup-')));
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('arm A: agentic candidates go through the same verification; without an approved env they are blocked, not confirmed', async () => {
  const r = await runArm('A');
  try {
    const f = r.pkg.findings.find((x) => x.title.startsWith('Non-positive'))!;
    assert.equal(f.status, 'blocked');
    assert.equal(f.verdict, 'UNCHALLENGED');
    assert.match(f.notes[0]!, /no approved L2 test environment/);
    assert.equal(r.structured.calls.length, 0, 'arm A makes no single-pass calls (no fix for an unconfirmed finding)');

    // Comparison across arms is computed from events and packages.
    const b = await runArm('B');
    try {
      const metrics = [armMetrics(r.events, r.artifacts, r.input.runId), armMetrics(b.events, b.artifacts, b.input.runId)];
      assert.equal(metrics[0]!.blocked, 1);
      assert.equal(metrics[1]!.notChecked, 1);
      assert.equal(metrics[1]!.missingContract, 1);
      const cmp = compareArms(metrics);
      assert.equal(cmp.unionConfirmed, 0);
      assert.match(renderComparison(cmp), /Relative confirmed recall \| — \| — \|/);
    } finally {
      rmSync(b.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('a resumed audit run redoes nothing', async () => {
  const r = await runArm('C');
  try {
    const before = r.structured.calls.length;
    const again = await runPrReview(r.deps, r.input);
    assert.equal(again.packageHash, r.result.packageHash);
    assert.equal(r.structured.calls.length, before);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('verification: confirmed only by an assertion failing on head and passing on base; an exception is not proof', async () => {
  const r = await runArm('B', { withEnv: true });
  try {
    const byTitle = (t: string) => r.pkg.findings.find((f) => f.title === t)!;
    const real = byTitle('Zero amounts reach the payment service');
    assert.equal(real.status, 'confirmed');
    assert.equal(real.evidence, 'REPRO_RED');
    assert.equal(real.verdict, 'STANDS');
    assert.match(real.notes.join('\n'), /Expected behaviour from rule business:CHK001/);
    assert.match(real.suggested_fix, /^AS-IS/, 'a fix is proposed once it is confirmed');
    const shaky = byTitle('Exception contract changed');
    assert.equal(shaky.status, 'unconfirmed');
    assert.match(shaky.notes[0]!, /exception, not an assertion/);
    assert.equal(shaky.suggested_fix, '', 'no fix for an unconfirmed finding');
    assert.deepEqual((r.deps.target as FakeMaven).runs.sort(), ['app.G1GatehouseReproTest@base', 'app.G1GatehouseReproTest@head', 'app.G2GatehouseReproTest@head']);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});
