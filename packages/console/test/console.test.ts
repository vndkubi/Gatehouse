import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobQueue, openRuntime } from '@gatehouse/app';
import { GitHubClient } from '@gatehouse/github';
import type { ReviewPackage } from '@gatehouse/workflows';
import { ConsoleServer, publishReview } from '../src/index.ts';
import { VirtualAuthenticator } from './virtual-authenticator.ts';

function fakeGitHub() {
  const posted: Array<{ body: string; comments: unknown[] }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { body: string; comments: unknown[] };
      posted.push(body);
      return Response.json({ id: posted.length, html_url: `https://github.com/o/r/pull/7#review-${posted.length}` });
    }
    if (String(url).includes('/reviews')) return Response.json(posted.map((p, i) => ({ id: i + 1, body: p.body, user: { login: 'me' } })));
    return Response.json({});
  }) as typeof fetch;
  return { client: new GitHubClient('https://api.github.example', 'token', fetchImpl), posted };
}

const pkg: ReviewPackage = {
  version: 1, runId: 'prr-demo-7', repo: 'demo',
  pr: { owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7', title: 'Fix total', author: 'dev' },
  source: { kind: 'pr', label: 'o/r#7' }, acStatus: [], orphans: [], blast: { symbols: 0, dependentFiles: [], testsAtRisk: [] }, incomplete: false, incompleteReasons: [],
  base: 'b'.repeat(40), head: 'h'.repeat(40), mergeBase: 'b'.repeat(40), envLevel: 'L2', requirements: null, units: [],
  ledger: { totalHunks: 1, reviewedHunks: 1, missing: [], incompleteUnits: [] }, unreviewable: [], masked: [],
  findings: [
    { id: 'F1', unit: 'U1', title: 'Subtracts', severity: 'P1', category: 'correctness', file: 'app/Pay.java', line: 3, evidence_quote: 'a - b', explanation: 'e', failing_scenario: 's', suggested_fix: 'f', repro: null, evidence: 'REPRO_RED', verdict: 'STANDS', inDiff: true, notes: [] },
    { id: 'F2', unit: 'U1', title: 'Made up', severity: 'P2', category: 'security', file: 'app/Pay.java', line: 2, evidence_quote: 'x', explanation: 'e', failing_scenario: 's', suggested_fix: 'f', repro: null, evidence: 'NO_EVIDENCE', verdict: 'REJECTED', inDiff: true, notes: [] },
  ],
  agents: {}, usage: { calls: 1, promptTokens: 1, completionTokens: 1, costUsd: null }, critic: 'codex', warnings: [],
};

test('passkey enrollment, signed approval, idempotent publish, and forged decisions refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-console-'));
  const previousHome = process.env.GATEHOUSE_HOME;
  process.env.GATEHOUSE_HOME = join(root, 'home');
  const rt = openRuntime(root);
  const { events, artifacts, approvers } = rt;
  const gh = fakeGitHub();
  const server = new ConsoleServer({ rt, queue: new JobQueue(1), port: 0, projectDir: root, github: async () => gh.client });
  const origin = await server.start();
  try {
    const page = await (await fetch(`${origin}/approvers`)).text();
    const csrf = /name="csrf" content="([^"]+)"/.exec(page)![1]!;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-csrf': csrf, ...headers }, body: JSON.stringify(body) });

    // Cross-site and DNS-rebinding style requests are refused.
    assert.equal((await post('/api/enroll/options', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/enroll/options', {}, { 'x-csrf': 'nope' })).status, 403);
    const rebinding = await new Promise<number>((resolve, reject) => {
      const u = new URL(origin);
      request({ host: '127.0.0.1', port: u.port, path: '/', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    assert.equal(rebinding, 421);

    // First approver: the terminal code alone is enough.
    const me = new VirtualAuthenticator('localhost', origin);
    const code = approvers.issueCode();
    const regOptions = (await (await post('/api/enroll/options', { code, name: 'son' })).json()) as { challenge: string };
    const enrolled = await post('/api/enroll/verify', { code, response: me.register(regOptions) });
    assert.equal(enrolled.status, 200, await enrolled.clone().text());
    assert.equal(approvers.list().length, 1);
    assert.equal(approvers.codeState(code), 'used');

    // A second approver needs an existing approver's signature first.
    const code2 = approvers.issueCode();
    assert.equal(approvers.codeState(code2), 'needs-authorization');
    assert.equal((await post('/api/enroll/options', { code: code2, name: 'intruder' })).status, 409);

    // Run waiting on GATE_5.
    const art = artifacts.putJson('pr.review.package', pkg);
    events.append(pkg.runId, 'RUN_STARTED', { workflow: 'pr-review', repo: 'demo', source: { kind: 'pr', owner: 'o', repoName: 'r', number: 7 } });
    events.append(pkg.runId, 'AWAITING_GATE', { gate: 'GATE_5', artifact: art.hash });

    const gateOptions = (await (await post(`/api/gates/${pkg.runId}/options`, { decision: 'approve' })).json()) as { challenge: string };
    const decided = (await (await post(`/api/gates/${pkg.runId}/decide`, { response: me.authenticate(gateOptions), reason: 'lgtm' })).json()) as { status: string };
    assert.equal(decided.status, 'published');
    assert.equal(gh.posted.length, 1);
    assert.equal(gh.posted[0]!.comments.length, 1, 'only the standing finding is posted inline');
    assert.match(gh.posted[0]!.body, /<!-- gatehouse:run=prr-demo-7 -->/);

    // Publishing again is a no-op.
    const again = (await (await post(`/api/runs/${pkg.runId}/publish`, {})).json()) as { status: string };
    assert.equal(again.status, 'already-published');
    assert.equal(gh.posted.length, 1);

    // A decision written straight into the event log (no valid signature) is refused.
    events.append('prr-forged', 'AWAITING_GATE', { gate: 'GATE_5', artifact: art.hash });
    const forgedAssertion = me.authenticate({ challenge: 'not-the-real-challenge' });
    events.append('prr-forged', 'GATE_DECISION', { gate: 'GATE_5', artifact: art.hash, decision: 'approve', reason: '', nonce: 'x', credentialId: me.id, assertion: forgedAssertion });
    const forged = await publishReview({ events, artifacts, approvers, github: gh.client, web: server.web, runId: 'prr-forged' });
    assert.equal(forged.status, 'refused');
    assert.equal(gh.posted.length, 1);

    // A valid signature replayed for another artifact version is refused too.
    const otherArt = artifacts.putJson('pr.review.package', { ...pkg, warnings: ['changed after approval'] });
    events.append(pkg.runId, 'AWAITING_GATE', { gate: 'GATE_5', artifact: otherArt.hash });
    const lastDecision = events.list(pkg.runId).filter((e) => e.type === 'GATE_DECISION').at(-1)!.payload as Record<string, unknown>;
    events.append(pkg.runId, 'GATE_DECISION', { ...lastDecision, artifact: otherArt.hash });
    const replay = await publishReview({ events, artifacts, approvers, github: gh.client, web: server.web, runId: pkg.runId });
    assert.equal(replay.status, 'refused');

    // Pages render for every section.
    for (const path of ['/', '/prs', '/new', '/repos', '/settings', '/evals', `/runs/${pkg.runId}`]) {
      const res = await fetch(`${origin}${path}`);
      assert.equal(res.status, 200, path);
    }
    const home = await (await fetch(`${origin}/`)).text();
    assert.match(home, /o\/r#7[\s\S]*Posted to GitHub/, 'plain-language status on the home page');
    assert.doesNotMatch(home, /GATE_5/, 'no internal gate names on the home page');
    const runHtml = await (await fetch(`${origin}/runs/${pkg.runId}`)).text();
    assert.match(runHtml, /Findings \(1\)/);
    assert.match(runHtml, /Critical/);

    // The local API token (IDE MCP server) can start jobs and read state, nothing else.
    const { consoleApiToken } = await import('../src/index.ts');
    const bearer = { authorization: `Bearer ${consoleApiToken(rt.paths.keys)}` };
    const api = (path: string, body: unknown, headers: Record<string, string>) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await api('/api/jobs/review', { repo: 'missing', pr: 1 }, bearer)).status, 400, 'token accepted for jobs (unknown repo rejected on its merits)');
    assert.equal((await api('/api/jobs/review', { repo: 'missing', pr: 1 }, { authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await api(`/api/gates/${pkg.runId}/options`, { decision: 'approve' }, bearer)).status, 403, 'no gate access with the token');
    assert.equal((await api(`/api/runs/${pkg.runId}/publish`, {}, bearer)).status, 403, 'no publish with the token');
    assert.equal((await api('/api/secrets/options', { name: 'github.pat' }, bearer)).status, 403, 'no secrets with the token');
    const ideTools = (await import('../../cli/src/mcp-serve.ts')).ideTools(origin, consoleApiToken(rt.paths.keys));
    const status = (await ideTools.find((t) => t.tool.name === 'run_status')!.call({ runId: pkg.runId })) as { status: string; url: string };
    assert.match(status.url, /\/runs\/prr-demo-7$/);
    assert.ok(!ideTools.some((t) => /approve|decide|publish|secret|setting/.test(t.tool.name)));

    // Settings changes need a passkey signature over exactly the patch.
    const patch = { 'review.maxWorkers': 3 };
    const unsigned = await post('/api/settings/save', { patch, response: me.authenticate({ challenge: 'forged' }) });
    assert.equal(unsigned.status, 403);
    const setOptions = (await (await post('/api/settings/options', { patch })).json()) as { challenge: string };
    const tampered = await post('/api/settings/save', { patch: { 'review.maxWorkers': 9 }, response: me.authenticate(setOptions) });
    assert.equal(tampered.status, 403, 'a signature for one patch cannot save another');
    const setOptions2 = (await (await post('/api/settings/options', { patch })).json()) as { challenge: string };
    const saved = await post('/api/settings/save', { patch, response: me.authenticate(setOptions2) });
    assert.equal(saved.status, 200, await saved.clone().text());
    const reloaded = openRuntime(root);
    assert.equal(reloaded.config.review.maxWorkers, 3);
    reloaded.close();
    const badOptions = (await (await post('/api/settings/options', { patch: { 'review.maxWorkers': 'many' } })).json()) as { challenge: string };
    const bad = await post('/api/settings/save', { patch: { 'review.maxWorkers': 'many' }, response: me.authenticate(badOptions) });
    assert.equal(bad.status, 400, 'invalid values are rejected before the file is written');
  } finally {
    await server.stop();
    rt.close();
    if (previousHome === undefined) delete process.env.GATEHOUSE_HOME;
    else process.env.GATEHOUSE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
