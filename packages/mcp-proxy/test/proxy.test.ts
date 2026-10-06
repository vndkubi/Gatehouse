import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventStore, RunTokenSigner } from '@gatehouse/core';
import { McpProxy, ToolDenied, classify } from '../src/index.ts';

const fakeServer = join(dirname(fileURLToPath(import.meta.url)), 'fake-tracker.mjs');

function proxy() {
  const events = new EventStore(':memory:');
  const signer = new RunTokenSigner(randomBytes(32));
  const p = new McpProxy({
    servers: {
      tracker: {
        command: process.execPath,
        args: [fakeServer],
        env: { JIRA_PAT: { secret: 'jira.pat' } },
        tools: { read: ['jira_get_*'], write: ['jira_add_comment'], deny: ['*secret*'] },
      },
    },
    events,
    signer,
    resolveSecret: async () => 'pat-value',
    dlp: { testPanAllowlist: ['4111111111111111'] },
  });
  return { p, events, signer };
}

test('manifest classification: deny wins, unlisted tools are undeclared', () => {
  const m = { read: ['jira_get_*'], write: ['jira_add_comment'], deny: ['*secret*'] };
  assert.equal(classify(m, 'jira_get_issue'), 'read');
  assert.equal(classify(m, 'jira_add_comment'), 'write');
  assert.equal(classify(m, 'jira_get_secret'), 'deny');
  assert.equal(classify(m, 'jira_delete_issue'), 'undeclared');
});

test('filters tools, enforces the manifest, redacts results and records every call', async () => {
  const { p, events } = proxy();
  try {
    assert.deepEqual((await p.listTools('tracker')).map((t) => t.name), ['jira_get_issue']);
    assert.deepEqual((await p.listTools('tracker', true)).map((t) => t.name).sort(), ['jira_add_comment', 'jira_get_issue']);

    const text = await p.callTool({ runId: 'r', stepId: 'intake', server: 'tracker', tool: 'jira_get_issue', args: { issue_key: 'PAY-1' } });
    assert.match(text, /^PAY-1: Payment fails for card \[PAN:[0-9a-f]{8}\] \(pat-present\)/);
    assert.match(text, /image content withheld/);

    await assert.rejects(p.callTool({ runId: 'r', stepId: 'x', server: 'tracker', tool: 'jira_add_comment', args: {} }), ToolDenied);
    await assert.rejects(p.callTool({ runId: 'r', stepId: 'x', server: 'tracker', tool: 'jira_secret_dump', args: {} }), ToolDenied);
    const types = events.list('r').map((e) => e.type);
    assert.deepEqual(types, ['TOOL_CALL', 'TOOL_DENIED', 'TOOL_DENIED']);
    assert.equal((events.list('r')[0]!.payload as { redactions: number }).redactions, 1);
  } finally {
    await p.close();
  }
});

test('agent-facing HTTP endpoint needs a run token and exposes read tools only', async () => {
  const { p, signer } = proxy();
  const base = await p.startHttp(0);
  try {
    const noAuth = await fetch(`${base}/tracker`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401);

    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/tracker`), { requestInit: { headers: { authorization: `Bearer ${signer.issue('r2', 'review', 60_000)}` } } }),
    );
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['jira_get_issue']);
    const res = await client.callTool({ name: 'jira_get_issue', arguments: { issue_key: 'PAY-2' } });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /^<untrusted source="mcp:tracker\/jira_get_issue">/);
    assert.ok(!text.includes('4539'));
    const denied = await client.callTool({ name: 'jira_add_comment', arguments: {} });
    assert.equal(denied.isError, true);
    await client.close();
  } finally {
    await p.close();
  }
});
