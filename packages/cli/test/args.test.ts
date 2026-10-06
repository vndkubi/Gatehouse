import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/main.ts';

test('parses positionals, value flags, inline values and booleans', () => {
  assert.deepEqual(parseArgs(['add', 'https://x/y.git', '--name', 'svc', '--pci=cde', '--keep', '--ref', 'dev']), {
    positional: ['add', 'https://x/y.git'],
    flags: { name: 'svc', pci: 'cde', keep: true, ref: 'dev' },
  });
});

test('boolean flags never swallow the next positional', () => {
  assert.deepEqual(parseArgs(['--no-fetch', 'svc']), { positional: ['svc'], flags: { 'no-fetch': true } });
});
