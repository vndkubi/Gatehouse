import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/index.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gh-config-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  return { root, home, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('defaults apply when no layer overrides them', () => {
  const f = fixture();
  try {
    const { config, sources } = loadConfig({ projectDir: f.project, env: { GATEHOUSE_HOME: f.home } });
    assert.equal(config.runtime.target, 'host');
    assert.equal(config.console.bind, '127.0.0.1');
    assert.equal(sources['scheduler.maxParallelRuns'], 'default');
    assert.ok(Object.isFrozen(config.scheduler));
  } finally {
    f.cleanup();
  }
});

test('layers win in order team < machine < env < override, with source tracking', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.project, 'gatehouse.config.yaml'), 'scheduler:\n  maxParallelRuns: 3\n  perRepoTestSteps: 2\npci:\n  defaultScope: connected\n');
    writeFileSync(join(f.home, 'config.local.yaml'), 'scheduler:\n  maxParallelRuns: 4\n');
    const env = { GATEHOUSE_HOME: f.home, GATEHOUSE__console__port: '9000' };
    const { config, sources } = loadConfig({ projectDir: f.project, env, overrides: { pci: { defaultScope: 'cde' } } });
    assert.equal(config.scheduler.maxParallelRuns, 4);
    assert.equal(sources['scheduler.maxParallelRuns'], 'machine');
    assert.equal(config.scheduler.perRepoTestSteps, 2);
    assert.equal(sources['scheduler.perRepoTestSteps'], 'team');
    assert.equal(config.console.port, 9000);
    assert.equal(sources['console.port'], 'env');
    assert.equal(config.pci.defaultScope, 'cde');
    assert.equal(sources['pci.defaultScope'], 'override');
  } finally {
    f.cleanup();
  }
});

test('invalid values and unknown keys are rejected with the offending layer', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.project, 'gatehouse.config.yaml'), 'scheduler:\n  maxParallelRuns: 0\n');
    assert.throws(() => loadConfig({ projectDir: f.project, env: { GATEHOUSE_HOME: f.home } }), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /scheduler\.maxParallelRuns .*\(from team\)/);
      return true;
    });
    writeFileSync(join(f.project, 'gatehouse.config.yaml'), 'scheduler:\n  typo: 1\n');
    assert.throws(() => loadConfig({ projectDir: f.project, env: { GATEHOUSE_HOME: f.home } }), /unknown key/);
    assert.throws(() => loadConfig({ env: { GATEHOUSE_HOME: f.home, GATEHOUSE__nope: '1' } }), /does not match/);
  } finally {
    f.cleanup();
  }
});
