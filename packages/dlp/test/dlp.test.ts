import assert from 'node:assert/strict';
import { test } from 'node:test';
import { luhnValid, redact, scan } from '../src/index.ts';

const ALLOW = { testPanAllowlist: ['4111111111111111'] };
// A Luhn-valid, Visa-shaped number that is not on the allowlist.
const REAL_LOOKING = '4539 1488 0343 6467';

test('Luhn check', () => {
  assert.equal(luhnValid('4539148803436467'), true);
  assert.equal(luhnValid('4539148803436468'), false);
});

test('finds PANs with separators but ignores allowlisted test PANs and non-card numbers', () => {
  const text = `log: card=${REAL_LOOKING} test=4111-1111-1111-1111 order=1234567890123 ts=1696500000000 ver=1.2.3.4`;
  const hits = scan(text, ALLOW);
  assert.deepEqual(hits.map((h) => h.detector), ['pan']);
  assert.equal(text.slice(hits[0]!.start, hits[0]!.end), REAL_LOOKING);
});

test('finds track data and credentials', () => {
  const text = [
    '%B4539148803436467^DOE/JOHN^2512101000000000000?',
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'aws AKIAIOSFODNN7EXAMPLE',
    'db.password = "Xk9#pQ2!vLz8@Rt4"',
    'password: ${DB_PASSWORD}',
  ].join('\n');
  const names = scan(text, ALLOW).map((h) => h.detector);
  assert.ok(names.includes('track1'));
  assert.ok(names.includes('github-token'));
  assert.ok(names.includes('aws-access-key'));
  assert.ok(names.includes('assigned-secret'));
  assert.equal(names.filter((n) => n === 'assigned-secret').length, 1, 'placeholders like ${DB_PASSWORD} are not secrets');
});

test('redact replaces values with stable placeholders and never echoes them', () => {
  const { text, hits } = redact(`a ${REAL_LOOKING} b ${REAL_LOOKING}`, ALLOW);
  assert.equal(hits.length, 2);
  assert.ok(!text.includes('4539'));
  const tokens = text.match(/\[PAN:[0-9a-f]{8}\]/g);
  assert.equal(tokens?.length, 2);
  assert.equal(tokens?.[0], tokens?.[1]);
});
