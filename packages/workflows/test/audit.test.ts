import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '@gatehouse/targets';
import {
  applyAnswer,
  boundarySignals,
  buildAuditItems,
  groupByRootCause,
  newOutcome,
  parseUnifiedDiff,
  planBatches,
  readSpecRules,
  resolveLookups,
  routeItems,
  specDirsFor,
  type AuditAnswer,
  type Candidate,
  type ItemOutcome,
  type ReviewUnit,
  type Viewpoint,
} from '../src/index.ts';

const answer = (over: Partial<AuditAnswer>): AuditAnswer => ({
  item_id: 'X',
  verdict: 'pass',
  evidence: [],
  rationale: 'r',
  missing_context: [],
  cross_service: 'none',
  requirement_issue: null,
  candidate: null,
  ...over,
});

test('Spec Kit rules are parsed deterministically and keyed by the content of every source file', () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-rules-'));
  try {
    const dir = join(root, 'specs', '001-pay');
    mkdirSync(join(dir, 'checklists'), { recursive: true });
    writeFileSync(join(dir, 'checklists', 'business.md'), '# Business\n- [ ] CHK001 Amount must be positive [Spec §FR-1]\n- [x] Refunds keep the currency\n');
    writeFileSync(
      join(dir, 'spec.md'),
      ['## Acceptance Scenarios', '1. **Given** an order, **When** paying 0, **Then** the payment is rejected', '', '## Decision table', '| Amount | Member | Fee |', '|---|---|---|', '| <100 | yes | 0 |', '| <100 | no | 2 |'].join('\n'),
    );
    const rules = readSpecRules(root, ['specs/001-pay']);
    assert.deepEqual(rules.checklists.map((c) => c.id), ['business:CHK001', 'business:CHK002']);
    assert.equal(rules.checklists[0]!.text, 'Amount must be positive [Spec §FR-1]');
    assert.equal(rules.scenarios[0]!.text, 'Given an order, When paying 0, Then the payment is rejected');
    assert.deepEqual(rules.decisions.map((d) => d.text), ['Amount = <100; Member = yes; Fee = 0', 'Amount = <100; Member = no; Fee = 2']);
    const before = rules.hash;
    writeFileSync(join(dir, 'spec.md'), 'changed');
    assert.notEqual(readSpecRules(root, ['specs/001-pay']).hash, before, 'any source change invalidates the rules');
    assert.deepEqual(specDirsFor(parseUnifiedDiff('diff --git a/specs/001-pay/spec.md b/specs/001-pay/spec.md\n--- a/specs/001-pay/spec.md\n+++ b/specs/001-pay/spec.md\n@@ -1 +1 @@\n-a\n+b\n')), ['specs/001-pay']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const unit = (u: Partial<ReviewUnit> & { id: string; kind: ReviewUnit['kind'] }): ReviewUnit => ({ hunkIds: [], files: [], lines: 0, riskTags: [], ...u });

test('items are batched by the code they are checked against, not by a fixed count', () => {
  const units = [
    unit({ id: 'T1', kind: 'T', hunkIds: ['H1', 'H2'], files: ['a/Pay.java'], riskTags: ['payment'] }),
    unit({ id: 'T2', kind: 'T', hunkIds: ['H3'], files: ['b/Log.java'] }),
    unit({ id: 'V-money', kind: 'V', hunkIds: ['H1'], files: ['a/Pay.java'], viewpoint: 'money', mandatory: true }),
    unit({ id: 'V-security', kind: 'V', hunkIds: ['H1', 'H3'], files: ['a/Pay.java', 'b/Log.java'], viewpoint: 'security', mandatory: true }),
  ];
  const viewpoints: Viewpoint[] = [
    { id: 'money', title: 'Money', mandatory: true, paths: [], content: [], checklist: ['rounding', 'boundaries'] },
    { id: 'security', title: 'Security', mandatory: true, paths: [], content: [], checklist: ['injection'] },
  ];
  const { items, regions } = buildAuditItems({
    units,
    requirements: { summary: '', acceptance_criteria: [{ id: 'AC1', text: 'pay adds' }], risks: [], open_questions: [] },
    viewpoints,
    rules: { checklists: [], scenarios: [], decisions: [], hash: '', files: [] },
  });
  const regionOf = (id: string) => items.find((i) => i.id === id)!.region;
  assert.equal(regionOf('V-money.1'), 'R-T1', 'a viewpoint inside one technical region reuses its pack');
  assert.equal(regionOf('V-security.1'), 'R-V-security', 'a viewpoint spanning regions gets its own');
  assert.equal(regionOf('AC1'), 'R-ALL');
  assert.equal(items.find((i) => i.id === 'AC1')!.highRisk, true, 'business rules on a payment change are high risk');
  assert.equal(items.find((i) => i.id === 'T1.tech')!.mandatory, true);
  assert.equal(items.find((i) => i.id === 'T1.conv')!.mandatory, false);
  assert.deepEqual(regions.map((r) => r.id).sort(), ['R-ALL', 'R-T1', 'R-T2', 'R-V-security']);

  const batches = planBatches(items, 1);
  const t1 = batches.filter((b) => b.region === 'R-T1');
  assert.ok(t1.every((b) => b.itemIds.length === 1));
  assert.deepEqual(new Set(t1.map((b) => b.lens)), new Set(['code', 'spec']), 'code and spec lenses are separate calls on the same pack');
  assert.equal(planBatches(items, 20).filter((b) => b.region === 'R-T1').length, 2);
});

test('a fail whose cause is not in the code is neither a pass nor a finding', () => {
  const ok = (c: { quote: string }) => c.quote === 'real';
  const r = applyAnswer(newOutcome('AC1'), answer({ item_id: 'AC1', verdict: 'fail', evidence: [{ file: 'a', line: 1, quote: 'invented' }], candidate: { title: 't', severity: 'P1', class: 'business', category: 'c', invariant: 'i', entry_point: 'e', cause: { file: 'a', line: 2, quote: 'invented' }, failing_scenario: 's' } }), 'audit', ok);
  assert.equal(r.outcome.status, 'cannot_determine');
  assert.equal(r.outcome.evidence.length, 0);
  assert.equal(r.candidate?.citationOk, false);
  assert.deepEqual(r.outcome.history, ['audit:fail→cannot_determine']);
});

test('arm B only verifies candidates; arm C also routes missing context, unknown cross-service impact, high risk and a sample of passes', () => {
  const units = [unit({ id: 'T1', kind: 'T', hunkIds: ['H1'], files: ['a/Bff.java'] }), unit({ id: 'V-money', kind: 'V', hunkIds: ['H1'], files: ['a/Bff.java'], viewpoint: 'money', mandatory: true })];
  const { items } = buildAuditItems({
    units,
    requirements: { summary: '', acceptance_criteria: [1, 2, 3, 4, 5].map((n) => ({ id: `AC${n}`, text: `rule ${n}` })), risks: [], open_questions: [] },
    viewpoints: [{ id: 'money', title: 'Money', mandatory: true, paths: [], content: [], checklist: ['rounding'] }],
    rules: { checklists: [], scenarios: [], decisions: [], hash: '', files: [] },
  });
  const outcomes = new Map<string, ItemOutcome>(items.map((i) => [i.id, { ...newOutcome(i.id), status: 'pass' }]));
  outcomes.set('T1.tech', { ...newOutcome('T1.tech'), status: 'fail' });
  outcomes.set('AC1', { ...newOutcome('AC1'), status: 'cannot_determine', missingContext: [{ need: 'contract', question: 'does payment validate?', lookup: ['PaymentClient'] }] });
  outcomes.set('AC2', { ...newOutcome('AC2'), status: 'pass', crossService: 'unknown' });
  const hasCandidate = (id: string) => id === 'T1.tech';

  const b = routeItems(items, outcomes, hasCandidate, { arm: 'B', auditSampleRate: 0.5, secondReadHighRisk: true }, 'run-1');
  assert.deepEqual([...b.entries()], [['T1.tech', ['candidate']]]);

  const c = routeItems(items, outcomes, hasCandidate, { arm: 'C', auditSampleRate: 0.5, secondReadHighRisk: true }, 'run-1');
  assert.deepEqual(c.get('AC1'), ['missing_context']);
  assert.deepEqual(c.get('AC2'), ['cross_service_unknown']);
  assert.deepEqual(c.get('V-money.1'), ['high_risk']);
  const sampled = [...c.entries()].filter(([, r]) => r.includes('audit_sample')).map(([id]) => id);
  assert.ok(sampled.length >= 1);
  assert.deepEqual(
    [...routeItems(items, outcomes, hasCandidate, { arm: 'C', auditSampleRate: 0.5, secondReadHighRisk: true }, 'run-1').entries()].filter(([, r]) => r.includes('audit_sample')).map(([id]) => id),
    sampled,
    'the sample is reproducible for a run',
  );
});

test('one root cause reported against two items and two call sites becomes one group', () => {
  const base = { severity: 'P1' as const, class: 'business' as const, category: 'validation', entry_point: 'pay', failing_scenario: 'pay(0) charges', origin: 'audit' as const, citationOk: true, notes: [] };
  const cands: Candidate[] = [
    { ...base, id: 'C1', itemId: 'AC1', title: 'Zero amount is charged', invariant: 'amount must be positive before charging', cause: { file: 'Bff.java', line: 6, quote: 'charge' }, evidence: [] },
    { ...base, id: 'C2', itemId: 'business:CHK001', title: 'Missing positive amount check', invariant: 'payment amount must be positive', cause: { file: 'Bff.java', line: 7, quote: 'charge' }, evidence: [{ file: 'Api.java', line: 3, quote: 'pay' }] },
    { ...base, id: 'C3', itemId: 'T1.tech', class: 'technical', title: 'Log leaks order id', invariant: 'no identifiers in logs', cause: { file: 'Bff.java', line: 8, quote: 'log' }, evidence: [] },
    { ...base, id: 'C4', itemId: 'AC2', title: 'bogus', invariant: 'x', cause: { file: 'Bff.java', line: 1, quote: 'x' }, evidence: [], citationOk: false },
  ];
  const groups = groupByRootCause(cands, () => 'pay');
  assert.equal(groups.length, 2, 'different invariants in the same method stay apart; rejected candidates are not grouped');
  const g = groups.find((x) => x.members.includes('C1'))!;
  assert.deepEqual(g.members, ['C1', 'C2']);
  assert.deepEqual(g.items, ['AC1', 'business:CHK001']);
  assert.deepEqual(g.locations.map((l) => `${l.file}:${l.line}`), ['Bff.java:6', 'Bff.java:7', 'Api.java:3']);
});

test('boundary signals and lookups find the downstream contract the repo does hold', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-lookup-'));
  try {
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'PaymentClient.java'), 'package app;\n@FeignClient(name = "payment-service")\ninterface PaymentClient {\n  void charge(String orderId, long cents);\n}\n');
    writeFileSync(join(root, 'app', 'Bff.java'), 'class Bff {\n  PaymentClient payments;\n  void pay() { payments.charge("o", 1); }\n}\n');
    await git(['init', '-q'], { cwd: root });
    await git(['add', '.'], { cwd: root });
    const [file] = parseUnifiedDiff('diff --git a/app/Bff.java b/app/Bff.java\n--- a/app/Bff.java\n+++ b/app/Bff.java\n@@ -1,3 +1,3 @@\n class Bff {\n-  Object payments;\n+  PaymentClient payments;\n   void pay() { payments.charge("o", 1); }\n');
    const signals = boundarySignals(file!.hunks);
    assert.equal(signals[0]?.kind, 'http-client');
    assert.ok(signals[0]?.lookups.includes('PaymentClient'));
    const r = await resolveLookups(root, ['PaymentClient', 'NoSuchService'], { maxPerLookup: 2, maxSnippets: 5 });
    assert.equal(r.snippets[0]?.file, 'app/PaymentClient.java', 'the declaration ranks first');
    assert.deepEqual(r.notFound, ['NoSuchService']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
