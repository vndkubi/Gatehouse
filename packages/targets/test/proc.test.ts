import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveExecutable, run } from '../src/index.ts';

const node = process.execPath;

test('captures stdout, stderr and exit code without a shell', async () => {
  const r = await run([node, '-e', 'process.stdout.write("out & <x>"); process.stderr.write("err"); process.exit(3)']);
  assert.equal(r.stdout, 'out & <x>');
  assert.equal(r.stderr, 'err');
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
});

test('arguments with shell metacharacters reach the process verbatim', async () => {
  const tricky = 'a & b | c > d "q" %PATH% $HOME';
  const r = await run([node, '-e', 'process.stdout.write(process.argv[1])', tricky]);
  assert.equal(r.stdout, tricky);
});

test('kills the process tree on timeout', async () => {
  const r = await run([node, '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 20_000);
});

test('missing commands report a spawn error instead of throwing', async () => {
  const r = await run(['gatehouse-definitely-not-a-command']);
  assert.ok(r.error);
});

test('resolveExecutable finds node and rejects unknown names', () => {
  assert.ok(resolveExecutable('node'));
  assert.equal(resolveExecutable('gatehouse-definitely-not-a-command'), null);
});
