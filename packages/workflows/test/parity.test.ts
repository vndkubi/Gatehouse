import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindSteps, changedSymbols, globToRegExp, loadRiskRouting, loadWorkflow, matchViewpoint, parseUnifiedDiff, planReview, renderHtml, validateWorkflow, type ReviewPackage } from '../src/index.ts';

const DIFF = `diff --git a/src/main/java/shop/service/PricingService.java b/src/main/java/shop/service/PricingService.java
--- a/src/main/java/shop/service/PricingService.java
+++ b/src/main/java/shop/service/PricingService.java
@@ -18,6 +18,9 @@ public class PricingService {
     public BigDecimal calculateTotal(Order order) {
-        return order.getSubtotal();
+        BigDecimal subtotal = order.getSubtotal();
+        BigDecimal fee = subtotal.compareTo(FREE_SHIPPING_THRESHOLD) > 0 ? BigDecimal.ZERO : FLAT_FEE;
+        return subtotal.add(fee);
     }
diff --git a/src/main/java/shop/web/rest/OrderResource.java b/src/main/java/shop/web/rest/OrderResource.java
--- a/src/main/java/shop/web/rest/OrderResource.java
+++ b/src/main/java/shop/web/rest/OrderResource.java
@@ -40,3 +40,4 @@ public class OrderResource {
     @PostMapping("/orders")
+    @PreAuthorize("hasRole('USER')")
     public ResponseEntity<Order> create(@RequestBody Order o) {
`;

test('globs and viewpoint routing fire on paths and on changed lines only', () => {
  assert.ok(globToRegExp('**/web/rest/**').test('src/main/java/shop/web/rest/OrderResource.java'));
  assert.ok(globToRegExp('**/*Price*').test('a/b/PriceCalc.java'));
  assert.ok(!globToRegExp('**/*Price*').test('a/Price/Calc.java'.replace('Price/', 'x/')));
  const vps = loadRiskRouting();
  const hunks = parseUnifiedDiff(DIFF).flatMap((f) => f.hunks);
  const fired = vps.filter((v) => matchViewpoint(v, hunks).length).map((v) => v.id);
  assert.deepEqual(fired.sort(), ['api-contract', 'money', 'security']);
  assert.ok(vps.find((v) => v.id === 'security')!.mandatory);
});

test('changed symbols come from declarations and hunk headers, skipping trivial names', () => {
  const names = changedSymbols(parseUnifiedDiff(DIFF), 10).map((s) => s.name);
  assert.ok(names.includes('calculateTotal'));
  assert.ok(names.includes('PricingService'));
  assert.ok(!names.includes('get'));
});

test('plan builds technical, business, viewpoint and seam units', () => {
  const files = parseUnifiedDiff(DIFF);
  const units = planReview({
    files,
    requirements: { summary: 's', acceptance_criteria: [{ id: 'AC1', text: 'a' }, { id: 'AC2', text: 'b' }, { id: 'AC3', text: 'c' }], risks: [], open_questions: [] },
    viewpoints: loadRiskRouting(),
    blast: { symbols: [{ name: 'calculateTotal', definedIn: files[0]!.file, usages: [{ file: 'src/main/java/shop/CheckoutService.java', line: 12, text: 'pricing.calculateTotal(o)', test: false }] }], testsAtRisk: [], dependentFiles: [] },
    maxLines: 400,
    maxSeamUnits: 3,
    maxAcPerUnit: 2,
  });
  assert.deepEqual(units.map((u) => `${u.kind}:${u.id}`), ['T:T1', 'B:B1', 'B:B2', 'V:V-security', 'V:V-money', 'V:V-api-contract', 'S:S1']);
  assert.deepEqual(units.find((u) => u.id === 'B2')!.acIds, ['AC3']);
  assert.deepEqual(units.find((u) => u.id === 'S1')!.files, [files[0]!.file, 'src/main/java/shop/CheckoutService.java']);
  assert.deepEqual(units.filter((u) => u.kind === 'T').flatMap((u) => u.hunkIds).sort(), ['H1', 'H2']);
});

test('the declared workflow and its implementation must match exactly', () => {
  const def = loadWorkflow('pr-review');
  assert.equal(def.finalGate, 'GATE_5');
  const impls = Object.fromEntries(def.steps.map((s) => [s.id, () => undefined]));
  assert.equal(bindSteps(def, impls).length, def.steps.length);
  assert.throws(() => bindSteps(def, { ...impls, extra: () => undefined }), /extra not declared/);
  const { freeze: _f, ...missing } = impls;
  assert.throws(() => bindSteps(def, missing), /no code for freeze/);
  assert.deepEqual(validateWorkflow({ id: 'x', version: 1, steps: [{ id: 'a', kind: 'agent' }] }), ['a: agent steps must name an executor role']);
});

test('HTML report escapes untrusted text', () => {
  const pkg = {
    version: 1, runId: 'r', repo: 'x', pr: null, source: { kind: 'refs', label: 'x: main...f' }, base: 'b', head: 'h', mergeBase: 'b', envLevel: 'L0',
    requirements: null, units: [], ledger: { totalHunks: 0, reviewedHunks: 0, missing: [], incompleteUnits: [] }, unreviewable: [], acStatus: [], orphans: [],
    blast: { symbols: 0, dependentFiles: [], testsAtRisk: [] }, incomplete: true, incompleteReasons: ['mandatory viewpoint security did not complete'], masked: [],
    findings: [{ id: 'F1', unit: 'T1', title: '<script>alert(1)</script>', severity: 'P1', category: 'security', file: 'a', line: 1, evidence_quote: 'q', explanation: 'e', failing_scenario: 's', suggested_fix: 'f', repro: null, evidence: 'CITED', verdict: 'STANDS', inDiff: true, notes: [] }],
    agents: {}, usage: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null }, critic: 'none', warnings: [],
  } as ReviewPackage;
  const html = renderHtml(pkg);
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /Incomplete review/);
});
