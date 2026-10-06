import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SecretStore } from '../src/index.ts';

test('file backend round-trips and lists names without values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-secrets-'));
  try {
    const store = new SecretStore(dir, 'file');
    await store.set('github.pat', 'github_pat_abc');
    assert.equal(await new SecretStore(dir, 'file').get('github.pat'), 'github_pat_abc');
    assert.deepEqual(store.list(), ['github.pat']);
    assert.equal(await store.get('missing'), null);
    await assert.rejects(store.require('missing'), /gatehouse secret set missing/);
    await assert.rejects(store.set('Bad Name', 'x'), /invalid secret name/);
    await store.remove('github.pat');
    assert.equal(store.has('github.pat'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DPAPI backend encrypts at rest and round-trips', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-secrets-'));
  try {
    const value = 'sk-test "quoted" $dollar `tick` ünïcode';
    await new SecretStore(dir, 'dpapi').set('llm.test', value);
    const onDisk = readFileSync(join(dir, 'llm.test.secret'), 'utf8');
    assert.ok(!onDisk.includes('sk-test'), 'plaintext must not be on disk');
    assert.equal(await new SecretStore(dir, 'dpapi').get('llm.test'), value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
