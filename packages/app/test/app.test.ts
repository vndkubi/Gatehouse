import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobQueue, imageFor, toCellCommand } from '../src/index.ts';

test('cell commands run repo scripts through sh and force Maven offline', () => {
  assert.deepEqual(toCellCommand(['./mvnw', '-B', 'test'], true), ['sh', '/work/mvnw', '-o', '-B', 'test']);
  assert.deepEqual(toCellCommand(['./mvnw', '-B', 'test'], false), ['sh', '/work/mvnw', '-B', 'test']);
  assert.deepEqual(toCellCommand(['npm', 'test'], true), ['npm', 'test']);
});

test('cell images follow the toolchain in the env spec', () => {
  assert.equal(imageFor({ stack: 'java-maven', toolchain: { jdk: { requirement: '17' } } }), 'eclipse-temurin:17-jdk');
  assert.equal(imageFor({ stack: 'java-maven', toolchain: { jdk: { measured: '21.0.11' } } }), 'eclipse-temurin:21-jdk');
  assert.equal(imageFor({ stack: 'node', toolchain: { node: { requirement: '>=20' } } }), 'node:20-bookworm-slim');
});

test('queue honours global concurrency and serializes jobs on the same repo', async () => {
  const q = new JobQueue(2);
  const timeline: string[] = [];
  const job = (name: string, ms: number) => async () => {
    timeline.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    timeline.push(`end ${name}`);
    return { runId: name, status: 'done' as const, message: '' };
  };
  q.submit('t', 'a1', 'repo-a', job('a1', 40));
  q.submit('t', 'a2', 'repo-a', job('a2', 10));
  q.submit('t', 'b1', 'repo-b', job('b1', 10));
  await q.idle();
  assert.ok(timeline.indexOf('start a2') > timeline.indexOf('end a1'), 'same repo never overlaps');
  assert.ok(timeline.indexOf('start b1') < timeline.indexOf('end a1'), 'other repos run in parallel');
  assert.ok(q.list().every((j) => j.state === 'done'));
});

test('host/cell parity: flaky tests are notes, real differences and missing tests fail parity', async () => {
  const { compareBaselines } = await import('../src/index.ts');
  const base = (tests: Record<string, 'passed' | 'failed' | 'skipped' | 'flaky'>) => ({ tool: 'surefire' as const, tests, summary: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 } });
  const r = compareBaselines(base({ a: 'passed', b: 'failed', c: 'flaky', d: 'passed' }), base({ a: 'passed', b: 'passed', c: 'failed', e: 'passed' }));
  assert.deepEqual(r.differences, [{ test: 'b', host: 'failed', cell: 'passed' }]);
  assert.deepEqual(r.onlyOnHost, ['d']);
  assert.deepEqual(r.onlyInCell, ['e']);
  assert.equal(r.notes.length, 1);
  const tc = compareBaselines(base({ 'app.DbIT#x': 'passed', 'app.DbIT#y': 'passed', 'app.Unit#z': 'passed' }), base({ 'app.DbIT#x': 'skipped', 'app.Unit#z': 'passed' }), new Set(['app.DbIT']));
  assert.deepEqual(tc.needsContainerRuntime, ['app.DbIT#x', 'app.DbIT#y']);
  assert.deepEqual([tc.differences, tc.onlyOnHost], [[], []]);
});
