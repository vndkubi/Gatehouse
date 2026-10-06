import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventStore } from '@gatehouse/core';
import { StepFailed, StepRunner, mapLimit } from '../src/index.ts';

test('completed steps are skipped on resume; failures are recorded and rethrown', async () => {
  const events = new EventStore(':memory:');
  let calls = 0;
  const first = new StepRunner(events, 'r');
  assert.deepEqual(await first.step('freeze', async () => ({ head: 'abc', n: ++calls })), { head: 'abc', n: 1 });
  await assert.rejects(first.step('review', async () => { throw new Error('boom'); }), StepFailed);

  // "Process restarts": a new runner over the same events.
  const resumed = new StepRunner(events, 'r');
  assert.deepEqual(await resumed.step('freeze', async () => ({ head: 'zzz', n: ++calls })), { head: 'abc', n: 1 });
  assert.equal(calls, 1);
  assert.equal(await resumed.step('review', async () => 'ok now'), 'ok now');
  assert.deepEqual(events.list('r').map((e) => e.type), ['STEP_STARTED', 'STEP_DONE', 'STEP_STARTED', 'STEP_FAILED', 'STEP_STARTED', 'STEP_DONE']);
  assert.equal(events.verify('r').ok, true);
});

test('mapLimit bounds concurrency and keeps order', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n * 5));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});
