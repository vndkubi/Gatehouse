import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, canRunWorkflow, loadConfig, resolveTier, type ExecutorRoute } from '../src/index.ts';

const deepseek: ExecutorRoute = {
  executor: 'copilot',
  mode: 'gateway',
  provider: { name: 'deepseek', config: { type: 'openai', baseUrl: 'https://api.deepseek.com', keySecret: 'k', tpspApproved: false } },
};
const codexSub: ExecutorRoute = { executor: 'codex', mode: 'subscription' };

test('out-of-scope repos may use any route', () => {
  assert.deepEqual(canRunWorkflow({ workflow: 'pr-review', repo: 'r', pciScope: 'out', routes: [deepseek, codexSub] }), { allow: true, reasons: [] });
});

test('in-scope repos reject unapproved providers and subscription executors', () => {
  const d = canRunWorkflow({ workflow: 'pr-review', repo: 'pay', pciScope: 'cde', routes: [deepseek, codexSub] });
  assert.equal(d.allow, false);
  assert.equal(d.reasons.length, 2);
  assert.match(d.reasons.join('\n'), /not an approved TPSP/);
  assert.match(d.reasons.join('\n'), /cannot inspect/);
  const approved: ExecutorRoute = { ...deepseek, provider: { name: 'azure', config: { ...deepseek.provider!.config, tpspApproved: true } } };
  assert.equal(canRunWorkflow({ workflow: 'pr-review', repo: 'pay', pciScope: 'connected', routes: [approved] }).allow, true);
});

test('record config merges per key across layers and validates entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-cfg-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(
      join(home, 'config.local.yaml'),
      [
        'llm:',
        '  providers:',
        '    local:',
        '      type: openai',
        '      baseUrl: http://127.0.0.1:11434/v1',
        '      keySecret: llm.local',
        '      tpspApproved: true',
        '  tiers:',
        '    tier-scale: local:qwen',
        'mcp:',
        '  servers:',
        '    tracker:',
        '      command: uv',
        '      args: [run, server.py]',
        '      env: { JIRA_PAT: { secret: jira.pat } }',
        '      tools: { read: [jira_get_issue] }',
      ].join('\n'),
    );
    const { config, sources } = loadConfig({ env: { GATEHOUSE_HOME: home } });
    assert.deepEqual(Object.keys(config.llm.providers).sort(), ['deepseek', 'local']);
    assert.equal(resolveTier(config, 'tier-scale').model, 'qwen');
    assert.equal(resolveTier(config, 'tier-workhorse').providerName, 'deepseek');
    assert.equal(config.mcp.servers.tracker?.tools.read?.[0], 'jira_get_issue');
    assert.equal(sources['mcp.servers'], 'machine');

    writeFileSync(join(home, 'config.local.yaml'), 'llm:\n  providers:\n    bad:\n      type: openai\n      baseUrl: http://evil.example\n      keySecret: x\n      tpspApproved: true\n');
    assert.throws(() => loadConfig({ env: { GATEHOUSE_HOME: home } }), (e: unknown) => e instanceof ConfigError && /baseUrl must be https/.test(e.message));
    writeFileSync(join(home, 'config.local.yaml'), 'mcp:\n  servers:\n    t:\n      command: x\n');
    assert.throws(() => loadConfig({ env: { GATEHOUSE_HOME: home } }), /tools manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
