import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExecutionTarget, RunResult, Workspace } from '@gatehouse/targets';
import { parseSurefireXml, verifyEnv, type EnvSpec } from '../src/index.ts';
import { SUREFIRE_XML, makeRepo } from './fixtures.ts';

test('parses surefire testcases including failures, errors and skips', () => {
  const xml = SUREFIRE_XML('com.acme.PayTest', [['ok', 'pass'], ['bad', 'fail'], ['later', 'skip']]).replace('<failure message="boom">', '<error type="X">').replace('</failure>', '</error>');
  assert.deepEqual(parseSurefireXml(xml).map((t) => [t.id, t.status]), [
    ['com.acme.PayTest#ok', 'passed'],
    ['com.acme.PayTest#bad', 'failed'],
    ['com.acme.PayTest#later', 'skipped'],
  ]);
});

const spec: EnvSpec = {
  specVersion: 1,
  repo: 'svc',
  derivedFrom: { ref: 'main', sha: 'abc' },
  target: 'host',
  stack: 'java-maven',
  toolchain: {},
  services: [],
  commands: {
    build: { argv: ['mvn', 'test-compile'], provenance: { kind: 'INFERRED', reason: 't' } },
    testAll: { argv: ['mvn', 'test'], provenance: { kind: 'INFERRED', reason: 't' } },
    testOne: { argv: ['mvn', 'test', '-Dtest={class}'], provenance: { kind: 'INFERRED', reason: 't' } },
  },
  needs: { containerRuntime: false },
  warnings: [],
};

/** Fake target that simulates Maven by writing surefire reports. */
type Behaviour = (argv: string[], call: number) => { code: number; reports?: Record<string, string> };

function fakeTarget(dir: string, behaviour: Behaviour) {
  const calls: string[][] = [];
  const target: ExecutionTarget = {
    kind: 'host',
    prepare: async () => ({ runId: 'r', repo: 'svc', sha: 'abc', dir }),
    destroy: async () => undefined,
    exec: async (_ws: Workspace, argv: string[]): Promise<RunResult> => {
      calls.push(argv);
      const b = behaviour(argv, calls.length);
      for (const [file, xml] of Object.entries(b.reports ?? {})) {
        mkdirSync(join(dir, 'target', 'surefire-reports'), { recursive: true });
        writeFileSync(join(dir, 'target', 'surefire-reports', file), xml);
      }
      const stderr = b.code ? ['[ERROR] Failed to execute goal x:y: boom -> [Help 1]', '[ERROR] ', '[ERROR] [Help 1] http://cwiki.apache.org/x'].join('\n') : '';
      return { argv, code: b.code, signal: null, stdout: '', stderr, durationMs: 5, timedOut: false, truncated: false };
    },
  };
  return { target, calls };
}

test('reaches L2 with a baseline, detects flaky tests and validates the single-test slot', async () => {
  const dir = makeRepo({});
  try {
    const { target, calls } = fakeTarget(dir, (argv): ReturnType<Behaviour> => {
      if (argv.includes('test-compile')) return { code: 0 };
      if (argv.some((a) => a.startsWith('-Dtest=') && a.includes('com.acme.FlakyTest'))) {
        return { code: 0, reports: { 'TEST-com.acme.FlakyTest.xml': SUREFIRE_XML('com.acme.FlakyTest', [['sometimes', 'pass']]) } };
      }
      if (argv.some((a) => a.startsWith('-Dtest='))) return { code: 0 };
      return {
        code: 1,
        reports: {
          'TEST-com.acme.OkTest.xml': SUREFIRE_XML('com.acme.OkTest', [['a', 'pass'], ['b', 'pass']]),
          'TEST-com.acme.FlakyTest.xml': SUREFIRE_XML('com.acme.FlakyTest', [['sometimes', 'fail']]),
          'TEST-com.acme.BrokenTest.xml': SUREFIRE_XML('com.acme.BrokenTest', [['always', 'fail']]),
        },
      };
    });
    const report = await verifyEnv(target, { runId: 'r', repo: 'svc', sha: 'abc', dir }, spec);
    assert.equal(report.level, 'L2');
    assert.deepEqual(report.baseline?.summary, { total: 4, passed: 2, failed: 1, skipped: 0, flaky: 1 });
    assert.equal(report.baseline?.tests['com.acme.FlakyTest#sometimes'], 'flaky');
    assert.equal(report.baseline?.tests['com.acme.BrokenTest#always'], 'failed');
    assert.deepEqual(calls.map((c) => c.at(-1)), ['test-compile', 'test', '-Dtest=com.acme.BrokenTest,com.acme.FlakyTest', '-Dtest=com.acme.OkTest']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stops at L0 when the build fails and at L1 when no reports appear', async () => {
  const dir = makeRepo({});
  try {
    const failing = fakeTarget(dir, () => ({ code: 1 }));
    const r0 = await verifyEnv(failing.target, { runId: 'r', repo: 'svc', sha: 'abc', dir }, spec);
    assert.equal(r0.level, 'L0');
    assert.match(r0.reasons[0]!, /build failed: exit 1 — \[ERROR\] Failed to execute goal x:y: boom/);

    const noReports = fakeTarget(dir, (argv) => ({ code: argv.includes('test') ? 1 : 0 }));
    const r1 = await verifyEnv(noReports.target, { runId: 'r', repo: 'svc', sha: 'abc', dir }, spec);
    assert.equal(r1.level, 'L1');
    assert.match(r1.reasons[0]!, /no Surefire reports/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
