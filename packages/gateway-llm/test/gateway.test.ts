import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventStore, RunTokenSigner, loadConfig } from '@gatehouse/core';
import { LlmGateway, RateLimiter } from '../src/index.ts';

const home = mkdtempSync(join(tmpdir(), 'gh-gw-'));
const { config } = loadConfig({ env: { GATEHOUSE_HOME: home }, overrides: { llm: { budgetTokensPerRun: 1_000 } } });

function setup() {
  const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ url, body, auth: new Headers(init.headers).get('authorization') });
    if (body.stream) {
      const sse = [
        'data: {"choices":[{"delta":{"content":"he"}}]}',
        'data: {"choices":[{"delta":{"content":"llo"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 600, completion_tokens: 500 } });
  }) as typeof fetch;
  const events = new EventStore(':memory:');
  const signer = new RunTokenSigner(randomBytes(32));
  const gw = new LlmGateway({ config, signer, events, providerKey: async () => 'sk-upstream-key', fetchImpl });
  return { gw, events, signer, seen };
}

const post = (base: string, token: string | null, body: unknown) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test('rejects missing, forged and expired run tokens', async () => {
  const { gw, signer } = setup();
  const base = await gw.start(0);
  try {
    assert.equal((await post(base, null, {})).status, 401);
    assert.equal((await post(base, new RunTokenSigner(randomBytes(32)).issue('r', 's', 60_000), {})).status, 401);
    assert.equal((await post(base, signer.issue('r', 's', -1), {})).status, 401);
  } finally {
    await gw.stop();
  }
});

test('maps tier aliases to provider models, injects the upstream key, records usage', async () => {
  const { gw, events, signer, seen } = setup();
  const base = await gw.start(0);
  try {
    const token = signer.issue('run-1', 'review', 60_000);
    assert.equal((await post(base, token, { model: 'gpt-4o', messages: [] })).status, 400);
    const res = await post(base, token, { model: 'tier-workhorse', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(seen[0]?.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(seen[0]?.body.model, 'deepseek-flash');
    assert.equal(seen[0]?.auth, 'Bearer sk-upstream-key');
    assert.deepEqual(gw.usageFor('run-1'), { calls: 1, promptTokens: 600, completionTokens: 500, cachedPromptTokens: 0, costUsd: null });
    const call = events.list('run-1').find((e) => e.type === 'MODEL_CALL');
    assert.equal((call?.payload as { model: string }).model, 'deepseek-flash');

    // 1,100 tokens used against a 1,000 budget: the next call is refused.
    const over = await post(base, token, { model: 'tier-workhorse', messages: [] });
    assert.equal(over.status, 402, 'not retryable');
    assert.ok(events.list('run-1').some((e) => e.type === 'BUDGET_EXCEEDED'));
  } finally {
    await gw.stop();
  }
});

test('streams through unchanged and captures usage from the final chunk', async () => {
  const { gw, signer, seen } = setup();
  const base = await gw.start(0);
  try {
    const res = await post(base, signer.issue('run-2', 's', 60_000), { model: 'tier-scale', stream: true, messages: [{ role: 'user', content: 'x' }] });
    const text = await res.text();
    assert.match(text, /"content":"he"/);
    assert.match(text, /\[DONE\]/);
    assert.deepEqual(seen[0]?.body.stream_options, { include_usage: true });
    assert.equal(gw.usageFor('run-2').promptTokens, 11);
  } finally {
    await gw.stop();
  }
});

test('blocks account data and redacts credentials before anything leaves the machine', async () => {
  const { gw, events, signer, seen } = setup();
  const base = await gw.start(0);
  try {
    const token = signer.issue('run-3', 'review', 60_000);
    const blocked = await post(base, token, { model: 'tier-workhorse', messages: [{ role: 'tool', content: 'customer card 4539 1488 0343 6467 declined' }] });
    assert.equal(blocked.status, 403);
    assert.equal(seen.length, 0, 'nothing was sent upstream');
    assert.ok(events.list('run-3').some((e) => e.type === 'DLP_EGRESS_BLOCK'));

    const allowedTestPan = await post(base, token, { model: 'tier-workhorse', messages: [{ role: 'user', content: 'fixture uses 4111 1111 1111 1111' }] });
    assert.equal(allowedTestPan.status, 200);

    // Fresh run: the previous call already spent this test's tiny token budget.
    await post(base, signer.issue('run-4', 'review', 60_000), {
      model: 'tier-workhorse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in config' }] }],
    });
    const sent = JSON.stringify(seen.at(-1)?.body.messages);
    assert.ok(!sent.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.match(sent, /\[REDACTED:github-token:[0-9a-f]{8}\]/);
  } finally {
    await gw.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('records provider-reported cache hits; never assumes them', async () => {
  const events = new EventStore(':memory:');
  const signer = new RunTokenSigner(randomBytes(32));
  let call = 0;
  const fetchImpl = (async () => {
    call++;
    const usage = call === 1 ? { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 64 } : call === 2 ? { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 32 } } : { prompt_tokens: 100, completion_tokens: 1 };
    return Response.json({ choices: [{ message: { content: 'ok' } }], usage });
  }) as typeof fetch;
  const { config: big } = loadConfig({ env: { GATEHOUSE_HOME: home } });
  const gw = new LlmGateway({ config: big, signer, events, providerKey: async () => 'k', fetchImpl });
  const base = await gw.start(0);
  try {
    const token = signer.issue('run-c', 'audit-T1', 60_000);
    for (let i = 0; i < 3; i++) assert.equal((await post(base, token, { model: 'tier-workhorse', messages: [{ role: 'user', content: 'x' }] })).status, 200);
    assert.equal(gw.usageFor('run-c').cachedPromptTokens, 96);
    const calls = events.list('run-c').filter((e) => e.type === 'MODEL_CALL').map((e) => (e.payload as { cachedPromptTokens: number }).cachedPromptTokens);
    assert.deepEqual(calls, [64, 32, 0]);
  } finally {
    await gw.stop();
  }
});

test('rate limiter: waits for room in the one-minute window and settles on reported usage', async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new RateLimiter({ rpm: 60, tpm: 1_000, countCachedTokens: false }, () => now, async (ms) => {
    waits.push(ms);
    now += ms;
  });
  const a = await limiter.acquire(600);
  assert.equal(a.waitedMs, 0);
  // The provider served 500 of the 600 prompt tokens from cache and does not count them.
  limiter.settle(a.ticket, { promptTokens: 600, completionTokens: 50, cachedPromptTokens: 500 });
  assert.deepEqual(limiter.window(), { requests: 1, tokens: 150 });
  now = 1_000;
  assert.equal((await limiter.acquire(800)).waitedMs, 0, 'fits once cached tokens are not counted');
  now = 2_000;
  const c = await limiter.acquire(500);
  assert.ok(c.waitedMs >= 58_000, `waits until the first call leaves the window (${c.waitedMs}ms)`);
  assert.equal(waits.length >= 1, true);
});
