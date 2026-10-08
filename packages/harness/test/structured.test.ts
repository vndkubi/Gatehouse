import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { RunTokenSigner } from '@gatehouse/core';
import { GatewayStructuredCaller, type StructuredRequest } from '../src/index.ts';

const schema = { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer' } } };
const req: StructuredRequest = { runId: 'r', stepId: 'audit-T1-code', tier: 'tier-workhorse', system: 'Count.', prefix: ['shared requirements', 'region pack'], tail: '## Batch\nitems: A', schema, responseFormat: 'json_object', timeoutMs: 5_000 };

test('one schema-checked call; a repair appends to the conversation so the prefix stays identical', async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: string }>; response_format?: unknown; temperature?: number }> = [];
  const replies = ['{"n":"two"}', '```json\n{"n":2}\n```'];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: replies[bodies.length - 1] } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: bodies.length === 2 ? 90 : 0 } });
  }) as typeof fetch;
  const caller = new GatewayStructuredCaller({ gatewayUrl: 'http://gw/v1', signer: new RunTokenSigner(randomBytes(32)), fetchImpl });
  const r = await caller.call(req);
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, { n: 2 });
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.usage, { promptTokens: 200, completionTokens: 10, cachedPromptTokens: 90 });
  assert.deepEqual(bodies[0]!.response_format, { type: 'json_object' });
  assert.equal(bodies[0]!.temperature, 0);
  assert.equal(bodies[0]!.messages[1]!.content, 'shared requirements\n\nregion pack\n\n## Batch\nitems: A', 'shared parts first, batch last');
  assert.deepEqual(bodies[1]!.messages.slice(0, 2), bodies[0]!.messages, 'the repair keeps the original messages as its prefix');
  assert.equal(bodies[1]!.messages[2]!.role, 'assistant');
});

test('retries 429 with Retry-After, and gives up on an exhausted budget without retrying', async () => {
  const slept: number[] = [];
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
    if (n === 2) return Response.json({ choices: [{ message: { content: '{"n":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    return new Response('{"error":{"type":"budget_exceeded"}}', { status: 402 });
  }) as typeof fetch;
  const caller = new GatewayStructuredCaller({ gatewayUrl: 'http://gw/v1', signer: new RunTokenSigner(randomBytes(32)), fetchImpl, sleep: async (ms) => void slept.push(ms) });
  assert.equal((await caller.call(req)).ok, true);
  assert.deepEqual(slept, [2_000]);
  const spent = await caller.call(req);
  assert.equal(spent.ok, false);
  assert.match(spent.errors[0]!, /402 \(token budget exhausted\)/);
  assert.equal(n, 3);
});
