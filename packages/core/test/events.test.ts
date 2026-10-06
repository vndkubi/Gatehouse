import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, GENESIS, stableStringify } from '../src/index.ts';

test('stableStringify ignores key order and drops undefined', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), stableStringify({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
});

test('events form a verifiable per-run hash chain', () => {
  const store = new EventStore(':memory:');
  const e1 = store.append('run-1', 'RUN_STARTED', { workflow: 'pr-review' });
  const e2 = store.append('run-1', 'STEP_DONE', { step: 'freeze', at: new Date('2026-10-06T00:00:00Z') });
  store.append('run-2', 'RUN_STARTED', {});
  assert.equal(e1.prevHash, GENESIS);
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(e2.seq, 2);
  assert.deepEqual(store.verify('run-1'), { ok: true, length: 2 });
  assert.deepEqual(store.runs(), ['run-1', 'run-2']);
  store.close();
});

test('tampering with a stored event is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-events-'));
  const file = join(dir, 'g.db');
  try {
    const store = new EventStore(file);
    store.append('r', 'A', { n: 1 });
    store.append('r', 'GATE_APPROVED', { gate: 'GATE_5' });
    store.append('r', 'C', { n: 3 });
    store.close();

    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE events SET payload = ? WHERE run_id = 'r' AND seq = 2").run(JSON.stringify({ gate: 'GATE_1' }));
    raw.close();

    const reopened = new EventStore(file);
    const check = reopened.verify('r');
    assert.equal(check.ok, false);
    assert.equal(check.ok === false && check.brokenAt, 2);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting an event is detected', () => {
  const store = new EventStore(':memory:');
  store.append('r', 'A', 1);
  store.append('r', 'B', 2);
  store.append('r', 'C', 3);
  // Reach into the same connection to simulate a deletion.
  (store as unknown as { db: DatabaseSync }).db.exec("DELETE FROM events WHERE run_id = 'r' AND seq = 2");
  const check = store.verify('r');
  assert.equal(check.ok, false);
  store.close();
});
