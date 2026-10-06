import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  answerQuestion,
  githubClient,
  legacyJob,
  onboardJob,
  recordRetro,
  resumeJob,
  retryFrom,
  reviewJob,
  runIdFor,
  reviewStart,
  ticketJob,
  ticketStart,
  type JobOutcome,
  type JobQueue,
  type QueuedJob,
  type Runtime,
} from '@gatehouse/app';
import { loadConfig, sha256Value, validRepoName, type RepoRecord } from '@gatehouse/core';
import { base64url, digest, gateChallenge, pendingGate, type GateDecision, type GateDecisionValue } from '@gatehouse/gates';
import { parseGitHubRemote, type GitHubClient } from '@gatehouse/github';
import { createMirror, defaultBranch } from '@gatehouse/targets';
import { latestEnv, loadWorkflow } from '@gatehouse/workflows';
import { publishBranch } from './branch-publisher.ts';
import { publishReview } from './publisher.ts';
import { allRuns, approversPage, evalsPage, homeLive, homePage, layout, newPage, prsPage, reposPage, runLive, runPage, settingsPage, type PageContext } from './pages.ts';
import { runInfo } from './views.ts';

export interface ConsoleOptions {
  rt: Runtime;
  queue: JobQueue;
  port: number;
  /** Directory holding the team config (gatehouse.config.yaml); defaults to the process cwd. */
  projectDir?: string;
  /** Overrides the GitHub client built from the stored token (tests, GitHub Enterprise proxies). */
  github?: () => Promise<GitHubClient>;
}

export type RunPublishOutcome = { status: string; url?: string; reason?: string };

const require = createRequire(import.meta.url);
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
const PENDING_TTL = 2 * 60_000;
const SECRET_NAME = /^(llm|github|jira|confluence|mcp)\.[a-z0-9._-]{1,60}$/;

type Pending = { challenge: string; expires: number; data: Record<string, string> };

/**
 * Bearer token for local tools (the IDE MCP server) to start jobs through the console. It can
 * only start work and read state; gate decisions, publishing, settings, secrets and enrollment
 * always need the browser session and a passkey.
 */
export function consoleApiToken(keysDir: string): string {
  const file = join(keysDir, 'console-api.token');
  if (!existsSync(file)) {
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
  }
  return readFileSync(file, 'utf8').trim();
}

/** The final gate of a workflow; reaching it approved means "publish". */
export function finalGateOf(workflow: string): string | undefined {
  if (workflow === 'env-onboarding') return 'GATE_ENV';
  try {
    return loadWorkflow(workflow).finalGate;
  } catch {
    return undefined;
  }
}

function startedPayload(rt: Runtime, runId: string): Record<string, unknown> {
  return (rt.events.list(runId).find((e) => e.type === 'RUN_STARTED')?.payload ?? {}) as Record<string, unknown>;
}

/**
 * Publishes an approved run: a PR review for pr-review, a branch + draft PR for ticket and
 * legacy-tests. The publishers re-verify the signed decision themselves.
 */
export async function publishRun(rt: Runtime, web: { rpID: string; origin: string }, runId: string, githubFor?: () => Promise<GitHubClient>): Promise<RunPublishOutcome> {
  const workflow = String(startedPayload(rt, runId).workflow ?? '');
  try {
    const github = githubFor ? await githubFor() : (await githubClient(rt, true))!;
    if (workflow === 'pr-review') return await publishReview({ events: rt.events, artifacts: rt.artifacts, approvers: rt.approvers, github, web, runId });
    if (workflow !== 'ticket' && workflow !== 'legacy-tests') return { status: 'refused', reason: `${workflow || 'this run'} has nothing to publish` };
    const repoName = String(startedPayload(rt, runId).repo ?? '');
    const repo = rt.repos.get(repoName);
    if (!repo) return { status: 'refused', reason: `unknown repo ${repoName}` };
    const token = await rt.secrets.require(rt.config.github.tokenSecret);
    return await publishBranch({ events: rt.events, artifacts: rt.artifacts, approvers: rt.approvers, github, token, repo, web, runId });
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }
}

/**
 * The Gatehouse console: dashboard, pull requests, runs, repositories, settings and approvals.
 * Bound to 127.0.0.1 and served as http://localhost:<port> (WebAuthn needs a hostname). Every
 * mutating request carries the page's CSRF token and a matching Origin/Host; decisions, settings
 * and secrets additionally need a passkey signature over exactly what changes.
 */
export class ConsoleServer {
  private server: Server | null = null;
  private readonly csrf = randomBytes(24).toString('base64url');
  private readonly pending = new Map<string, Pending>();
  private origin = '';
  private readonly rpID = 'localhost';
  private readonly rt: Runtime;
  private readonly queue: JobQueue;
  private readonly apiToken: Buffer;
  /** Console jobs by the run they work on, so pages can tell "running now" from "interrupted". */
  private readonly runJobs = new Map<string, QueuedJob>();

  constructor(private readonly o: ConsoleOptions) {
    this.rt = o.rt;
    this.queue = o.queue;
    this.apiToken = Buffer.from(`Bearer ${consoleApiToken(o.rt.paths.keys)}`);
  }

  private bearerOk(req: IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization ?? ''));
    return got.length === this.apiToken.length && timingSafeEqual(got, this.apiToken);
  }

  get web() {
    return { rpID: this.rpID, origin: this.origin };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err: Error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.o.port, '127.0.0.1', resolve));
    this.origin = `http://localhost:${(this.server.address() as AddressInfo).port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  // ---- routing --------------------------------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const port = new URL(this.origin).port;
    const host = req.headers.host ?? '';
    if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return send(res, 421, 'text/plain', 'Misdirected request');
    const p = url.pathname;

    if (req.method === 'GET') {
      const ctx = this.ctx;
      if (p === '/') return this.page(res, 'Home', homePage(ctx), 'home');
      if (p === '/prs') return this.page(res, 'Pull requests', await prsPage(ctx), 'prs');
      if (p === '/new') return this.page(res, 'New task', newPage(ctx), 'new');
      if (p === '/repos') return this.page(res, 'Repositories', await reposPage(ctx), 'repos');
      if (p === '/settings') return this.page(res, 'Settings', settingsPage(ctx), 'settings');
      if (p === '/approvers') return this.page(res, 'Passkeys', approversPage(ctx), 'settings');
      if (p === '/evals') return this.page(res, 'Quality', evalsPage(ctx), 'settings');
      const run = /^\/runs\/([\w.-]+)$/.exec(p);
      if (run) {
        const r = runPage(ctx, run[1]!);
        return this.page(res, r.title, r.html, '');
      }
      if (p === '/api/live') return json(res, 200, homeLive(ctx));
      const liveRun = /^\/api\/runs\/([\w.-]+)\/live$/.exec(p);
      if (liveRun) return json(res, 200, runLive(ctx, liveRun[1]!));
      const report = /^\/runs\/([\w.-]+)\/report$/.exec(p);
      if (report) return this.report(res, report[1]!);
      if (p === '/api/jobs') return json(res, 200, this.queue.list().map(publicJob));
      if (p === '/api/runs') return json(res, 200, this.allRuns());
      if (p === '/api/repos') return json(res, 200, this.repoList());
      if (p === '/api/prs') return this.prList(res, url.searchParams.get('repo') ?? '');
      const apiRun = /^\/api\/runs\/([\w.-]+)$/.exec(p);
      if (apiRun) return json(res, 200, { ...runInfo(this.rt.events, apiRun[1]!), url: `${this.origin}/runs/${apiRun[1]}` });
      const summary = /^\/api\/runs\/([\w.-]+)\/summary$/.exec(p);
      if (summary) return this.summary(res, summary[1]!);
      if (p === '/static/webauthn.js') return send(res, 200, 'text/javascript', readFileSync(require.resolve('@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
      if (p === '/static/app.js') return send(res, 200, 'text/javascript', readFileSync(join(STATIC_DIR, 'app.js')));
      return send(res, 404, 'text/plain', 'Not found');
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed');
    const job = /^\/api\/jobs\/(review|branch-review|ticket|legacy|onboard)$/.exec(p);
    const browser = req.headers.origin === this.origin && req.headers['x-csrf'] === this.csrf;
    // Local tools may start jobs with the bearer token; nothing else is reachable that way.
    if (!browser && !(job && this.bearerOk(req))) return json(res, 403, { error: 'cross-origin or missing CSRF token' });
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;

    const gate = /^\/api\/gates\/([\w.-]+)\/(options|decide)$/.exec(p);
    if (gate) return gate[2] === 'options' ? this.gateOptions(res, gate[1]!, body) : this.gateDecide(res, gate[1]!, body);
    const runAct = /^\/api\/runs\/([\w.-]+)\/(publish|resume|answer|retry)$/.exec(p);
    if (runAct) return this.runAction(res, runAct[1]!, runAct[2]!, body);
    if (job) return this.startJob(res, job[1]!, body);
    if (p === '/api/repos') return this.addRepo(res, body);
    if (p === '/api/settings/options') return this.signOptions(res, 'settings', body);
    if (p === '/api/secrets/options') return this.signOptions(res, 'secret', body);
    if (p === '/api/settings/save') return this.saveSettings(res, body);
    if (p === '/api/secrets/save') return this.saveSecret(res, body);
    if (p === '/api/enroll/authorize-options') return this.enrollAuthorizeOptions(res, body);
    if (p === '/api/enroll/authorize') return this.enrollAuthorize(res, body);
    if (p === '/api/enroll/options') return this.enrollOptions(res, body);
    if (p === '/api/enroll/verify') return this.enrollVerify(res, body);
    return json(res, 404, { error: 'unknown endpoint' });
  }

  // ---- jobs -----------------------------------------------------------------------------------

  private repoList() {
    return this.rt.repos.list().map((r) => {
      const env = latestEnv(this.rt.events, this.rt.artifacts, r.name);
      return { name: r.name, source: r.source, defaultBranch: r.defaultBranch, pciScope: r.pciScope, envLevel: env.level, envRun: env.onboardRun };
    });
  }

  private async prList(res: ServerResponse, repoName: string) {
    const repo = this.rt.repos.get(repoName);
    const remote = repo ? parseGitHubRemote(repo.source) : null;
    if (!repo || !remote) return json(res, 400, { error: `unknown or non-GitHub repo ${repoName}` });
    const gh = await (this.o.github ? this.o.github() : githubClient(this.rt));
    if (!gh) return json(res, 400, { error: 'no GitHub client' });
    try {
      return json(res, 200, await gh.listOpenPulls(remote.owner, remote.repo));
    } catch (err) {
      return json(res, 502, { error: (err as Error).message });
    }
  }

  private summary(res: ServerResponse, runId: string) {
    const out = join(this.rt.paths.runs, runId, 'out');
    for (const f of ['SUMMARY.md', 'TICKET.md', 'COVERAGE.md']) {
      if (existsSync(join(out, f))) return json(res, 200, { runId, file: f, markdown: readFileSync(join(out, f), 'utf8') });
    }
    return json(res, 404, { error: 'no summary for this run yet' });
  }

  private submit(kind: string, label: string, repo: string, runId: string, fn: (log: (l: string) => void) => Promise<JobOutcome>): QueuedJob {
    const job = this.queue.submit(kind, label, `repo:${repo}`, (j) => fn((line) => j.log.push(line)));
    Object.assign(job, { runId });
    this.runJobs.set(runId, job);
    return job;
  }

  private startJob(res: ServerResponse, kind: string, b: Record<string, unknown>) {
    const repo = String(b.repo ?? '');
    if (!this.rt.repos.get(repo)) return json(res, 400, { error: `unknown repo ${repo}` });
    let job: QueuedJob;
    let runId = '';
    try {
      if (kind === 'review') {
        const pr = Number(b.pr);
        if (!Number.isInteger(pr) || pr < 1) throw new Error('pr must be a positive number');
        const start = reviewStart(this.rt, { repo, pr, critic: b.critic !== false });
        runId = runIdFor('prr', repo, pr);
        job = this.submit('pr-review', `Review ${repo}#${pr}`, repo, runId, (log) => reviewJob(this.rt, start, log, runId));
      } else if (kind === 'branch-review') {
        const head = String(b.head ?? '').trim();
        if (!head) throw new Error('head ref required');
        const start = reviewStart(this.rt, { repo, head, base: b.base ? String(b.base) : undefined });
        runId = runIdFor('prr', repo, 'branch');
        job = this.submit('pr-review', `Branch review ${repo} ${head}`, repo, runId, (log) => reviewJob(this.rt, start, log, runId));
      } else if (kind === 'ticket') {
        let dir: string | null = null;
        let ticketFile: string | undefined;
        if (typeof b.text === 'string' && b.text.trim()) {
          dir = mkdtempSync(join(tmpdir(), 'gh-ticket-'));
          ticketFile = join(dir, 'ticket.md');
          writeFileSync(ticketFile, b.text);
        }
        try {
          const start = ticketStart(this.rt, { repo, ticket: String(b.ticket ?? '').trim(), ticketFile });
          runId = runIdFor('tkt', repo, start.ticketKey);
          job = this.submit('ticket', `Ticket ${start.ticketKey} on ${repo}`, repo, runId, (log) => ticketJob(this.rt, start, log, runId));
        } finally {
          if (dir) rmSync(dir, { recursive: true, force: true });
        }
      } else if (kind === 'legacy') {
        const top = b.top ? Number(b.top) : undefined;
        const start = { workflow: 'legacy-tests' as const, repo, scope: b.scope ? String(b.scope) : undefined, maxTargets: top && top > 0 ? top : undefined };
        runId = runIdFor('lgt', repo);
        job = this.submit('legacy-tests', `Tests for legacy code in ${repo}`, repo, runId, (log) => legacyJob(this.rt, start, log, runId));
      } else {
        const target = b.target === 'cell' ? 'cell' : 'host';
        runId = runIdFor('onboard', repo);
        job = this.submit('env-onboarding', `Check ${repo} ${target === 'cell' ? 'in a sandbox' : 'on this computer'}`, repo, runId, (log) => onboardJob(this.rt, { repo, target }, log, runId));
      }
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
    return json(res, 200, { job: job.id, runId });
  }

  private async runAction(res: ServerResponse, runId: string, action: string, b: Record<string, unknown>) {
    if (!this.rt.events.list(runId).length) return json(res, 404, { error: 'unknown run' });
    if (action === 'publish') return json(res, 200, await publishRun(this.rt, this.web, runId, this.o.github));
    try {
      if (action === 'answer') answerQuestion(this.rt, runId, String(b.q ?? ''), String(b.answer ?? ''));
      if (action === 'retry') retryFrom(this.rt, runId, String(b.stage ?? ''), b.note ? String(b.note) : undefined);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
    return json(res, 200, { job: this.resume(runId, action).id, runId });
  }

  private resume(runId: string, why: string): QueuedJob {
    const info = runInfo(this.rt.events, runId);
    const repo = String(startedPayload(this.rt, runId).repo ?? 'unknown');
    return this.submit(info.workflow, `${info.title.replace(/^[^:]+:\s*/, '')} (${why})`, repo, runId, (log) => resumeJob(this.rt, runId, log));
  }

  private async addRepo(res: ServerResponse, b: Record<string, unknown>) {
    const source = String(b.source ?? '').trim();
    const gh = parseGitHubRemote(source);
    if (!/^https:\/\//.test(source) || !gh) return json(res, 400, { error: 'give an https GitHub URL' });
    const name = String(b.name ?? '').trim() || gh.repo;
    if (!validRepoName(name)) return json(res, 400, { error: `invalid name ${name}` });
    if (this.rt.repos.get(name)) return json(res, 409, { error: `${name} is already registered` });
    const pci = (['cde', 'connected', 'out'].includes(String(b.pci)) ? String(b.pci) : 'out') as RepoRecord['pciScope'];
    const mirror = join(this.rt.paths.mirrors, `${name}.git`);
    await createMirror(source, mirror);
    this.rt.repos.add({ name, source, mirror, defaultBranch: await defaultBranch(mirror), pciScope: pci, addedAt: new Date().toISOString() });
    this.rt.events.append(`repo:${name}`, 'REPO_ADDED', { source, pciScope: pci, via: 'console' });
    return json(res, 200, { name });
  }

  // ---- gates ----------------------------------------------------------------------------------

  private async gateOptions(res: ServerResponse, runId: string, b: Record<string, unknown>) {
    const decision = b.decision === 'approve' ? 'approve' : b.decision === 'reject' ? 'reject' : null;
    const gate = pendingGate(this.rt.events, runId);
    if (!decision || !gate) return json(res, 409, { error: 'nothing to decide for this run' });
    const approvers = this.rt.approvers.list();
    if (!approvers.length) return json(res, 409, { error: 'no approver enrolled; run `gatehouse approver enroll` and open /approvers' });
    const nonce = randomBytes(16).toString('base64url');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: gateChallenge(gate.gate, runId, gate.artifact, decision, nonce),
      userVerification: 'required',
      allowCredentials: approvers.map((a) => ({ id: a.credentialId })),
    });
    this.pending.set(`gate:${runId}`, { challenge: options.challenge, expires: Date.now() + PENDING_TTL, data: { decision, nonce, gate: gate.gate, artifact: gate.artifact } });
    return json(res, 200, options);
  }

  private async gateDecide(res: ServerResponse, runId: string, b: Record<string, unknown>) {
    const p = this.take(`gate:${runId}`);
    if (!p) return json(res, 409, { error: 'no pending approval (expired?); try again' });
    const current = pendingGate(this.rt.events, runId);
    if (!current || current.gate !== p.data.gate || current.artifact !== p.data.artifact) return json(res, 409, { error: 'the gate changed while you were deciding; reload' });
    const response = b.response as AuthenticationResponseJSON;
    if (!(await this.verifyAssertion(response, p.challenge))) return json(res, 403, { error: 'signature did not verify' });
    const decision: GateDecision = {
      gate: p.data.gate!,
      artifact: p.data.artifact!,
      decision: p.data.decision as GateDecisionValue,
      reason: String(b.reason ?? '').slice(0, 2_000),
      nonce: p.data.nonce!,
      credentialId: response.id,
      assertion: response,
    };
    this.rt.events.append(runId, 'GATE_DECISION', decision);
    return json(res, 200, await this.afterDecision(runId, decision));
  }

  /** Intermediate gate approved: continue the run. Final gate approved: publish. Always: retro. */
  private async afterDecision(runId: string, d: GateDecision): Promise<Record<string, unknown>> {
    const info = runInfo(this.rt.events, runId);
    const final = finalGateOf(info.workflow);
    if (info.workflow === 'env-onboarding') return { status: d.decision === 'approve' ? 'environment approved' : 'environment rejected' };
    if (d.decision === 'reject') {
      if (d.gate === final) recordRetro(this.rt, runId);
      return { status: 'rejected', next: d.gate === final ? undefined : 'retry a stage with your feedback from the run page' };
    }
    if (d.gate === final) {
      const outcome = await publishRun(this.rt, this.web, runId, this.o.github);
      recordRetro(this.rt, runId);
      return outcome;
    }
    return { status: 'approved', job: this.resume(runId, 'continuing after your approval').id, runId };
  }

  private async verifyAssertion(response: AuthenticationResponseJSON | undefined, expectedChallenge: string): Promise<boolean> {
    const approver = response?.id ? this.rt.approvers.get(response.id) : null;
    if (!approver || !response) return false;
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: { id: approver.credentialId, publicKey: Buffer.from(approver.publicKey, 'base64url'), counter: approver.counter },
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const, authenticationInfo: { newCounter: 0 } }));
    if (v.verified) this.rt.approvers.setCounter(approver.credentialId, v.authenticationInfo.newCounter);
    return v.verified;
  }

  // ---- settings & secrets (passkey-signed) ----------------------------------------------------

  private async signOptions(res: ServerResponse, kind: 'settings' | 'secret', b: Record<string, unknown>) {
    const approvers = this.rt.approvers.list();
    if (!approvers.length) return json(res, 409, { error: 'enroll an approver first (/approvers)' });
    // The signature covers exactly what will change (a secret's name, never its value).
    const subject = kind === 'settings' ? sha256Value(b.patch ?? null) : String(b.name ?? '');
    const nonce = randomBytes(16).toString('base64url');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: digest(`gatehouse-${kind}|${subject}|${nonce}`),
      userVerification: 'required',
      allowCredentials: approvers.map((a) => ({ id: a.credentialId })),
    });
    this.pending.set(`${kind}:${subject}`, { challenge: options.challenge, expires: Date.now() + PENDING_TTL, data: {} });
    return json(res, 200, options);
  }

  private async saveSettings(res: ServerResponse, b: Record<string, unknown>) {
    const patch = b.patch as Record<string, unknown> | undefined;
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) return json(res, 400, { error: 'nothing changed' });
    const p = this.take(`settings:${sha256Value(patch)}`);
    if (!p || !(await this.verifyAssertion(b.response as AuthenticationResponseJSON, p.challenge))) return json(res, 403, { error: 'passkey confirmation failed' });
    const file = this.rt.paths.machineConfig;
    const doc = ((existsSync(file) ? parseYaml(readFileSync(file, 'utf8')) : null) ?? {}) as Record<string, unknown>;
    for (const [path, value] of Object.entries(patch)) setPath(doc, path, value);
    // Validate the result with the real loader before replacing the file.
    const tmp = mkdtempSync(join(tmpdir(), 'gh-settings-'));
    try {
      writeFileSync(join(tmp, 'config.local.yaml'), stringifyYaml(doc));
      loadConfig({ projectDir: this.o.projectDir ?? process.cwd(), env: { ...process.env, GATEHOUSE_HOME: tmp } });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    writeFileSync(`${file}.tmp`, stringifyYaml(doc));
    renameSync(`${file}.tmp`, file);
    this.rt.events.append('settings', 'SETTINGS_CHANGED', { paths: Object.keys(patch), by: String((b.response as { id?: string }).id ?? '').slice(0, 12) });
    return json(res, 200, { status: 'saved', note: 'New runs started from the CLI use it now; restart `gatehouse serve` for console-started runs.' });
  }

  private async saveSecret(res: ServerResponse, b: Record<string, unknown>) {
    const name = String(b.name ?? '');
    if (!SECRET_NAME.test(name)) return json(res, 400, { error: 'secret names look like llm.<x>, github.<x>, jira.<x>, confluence.<x> or mcp.<x>' });
    const value = String(b.value ?? '');
    if (!value) return json(res, 400, { error: 'empty value' });
    const p = this.take(`secret:${name}`);
    if (!p || !(await this.verifyAssertion(b.response as AuthenticationResponseJSON, p.challenge))) return json(res, 403, { error: 'passkey confirmation failed' });
    await this.rt.secrets.set(name, value);
    this.rt.events.append('settings', 'SECRET_SET', { name });
    return json(res, 200, { status: 'stored' });
  }

  // ---- enrollment -----------------------------------------------------------------------------

  private async enrollAuthorizeOptions(res: ServerResponse, b: Record<string, unknown>) {
    const code = String(b.code ?? '');
    const state = this.rt.approvers.codeState(code);
    if (state !== 'needs-authorization') return json(res, 409, { error: `code is ${state}` });
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: digest(`gatehouse-enroll|${code}|${randomBytes(16).toString('hex')}`),
      userVerification: 'required',
      allowCredentials: this.rt.approvers.list().map((a) => ({ id: a.credentialId })),
    });
    this.pending.set(`enroll-auth:${code}`, { challenge: options.challenge, expires: Date.now() + PENDING_TTL, data: {} });
    return json(res, 200, options);
  }

  private async enrollAuthorize(res: ServerResponse, b: Record<string, unknown>) {
    const code = String(b.code ?? '');
    const p = this.take(`enroll-auth:${code}`);
    if (!p || !(await this.verifyAssertion(b.response as AuthenticationResponseJSON, p.challenge))) return json(res, 403, { error: 'authorization failed' });
    this.rt.approvers.authorizeCode(code);
    return json(res, 200, { status: 'authorized' });
  }

  private async enrollOptions(res: ServerResponse, b: Record<string, unknown>) {
    const code = String(b.code ?? '');
    const state = this.rt.approvers.codeState(code);
    if (state !== 'ready') return json(res, 409, { error: `code is ${state}`, state });
    const name = String(b.name ?? 'approver').slice(0, 64) || 'approver';
    const options = await generateRegistrationOptions({
      rpName: 'Gatehouse',
      rpID: this.rpID,
      userName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: this.rt.approvers.list().map((a) => ({ id: a.credentialId })),
    });
    this.pending.set(`enroll-reg:${code}`, { challenge: options.challenge, expires: Date.now() + PENDING_TTL, data: { name } });
    return json(res, 200, options);
  }

  private async enrollVerify(res: ServerResponse, b: Record<string, unknown>) {
    const code = String(b.code ?? '');
    const p = this.take(`enroll-reg:${code}`);
    if (!p || this.rt.approvers.codeState(code) !== 'ready') return json(res, 409, { error: 'enrollment expired; start again' });
    const v = await verifyRegistrationResponse({
      response: b.response as RegistrationResponseJSON,
      expectedChallenge: p.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const, registrationInfo: undefined }));
    if (!v.verified || !v.registrationInfo) return json(res, 403, { error: 'registration did not verify' });
    const { credential, aaguid } = v.registrationInfo;
    this.rt.approvers.add({ credentialId: credential.id, publicKey: base64url(credential.publicKey), counter: credential.counter, name: p.data.name!, aaguid, createdAt: new Date().toISOString() });
    this.rt.approvers.consumeCode(code);
    return json(res, 200, { status: 'enrolled', name: p.data.name });
  }

  private take(key: string): Pending | null {
    const p = this.pending.get(key);
    this.pending.delete(key);
    return p && p.expires > Date.now() ? p : null;
  }

  // ---- pages (rendered by pages.ts) ------------------------------------------------------------

  private get ctx(): PageContext {
    return {
      rt: this.rt,
      csrf: this.csrf,
      projectDir: this.o.projectDir ?? process.cwd(),
      activeRun: (runId) => {
        const j = this.runJobs.get(runId);
        return j && (j.state === 'queued' || j.state === 'running') ? j.state : null;
      },
      jobs: () => this.queue.list(),
      github: () => (this.o.github ? this.o.github() : githubClient(this.rt)),
    };
  }

  private page(res: ServerResponse, title: string, body: string, nav: Parameters<typeof layout>[3] = '') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(layout(this.ctx, title, body, nav));
  }

  private allRuns() {
    return allRuns(this.ctx);
  }

  private report(res: ServerResponse, runId: string) {
    const out = join(this.rt.paths.runs, runId, 'out');
    for (const f of ['review.html', 'coverage-report.html']) {
      if (existsSync(join(out, f))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
        return void res.end(readFileSync(join(out, f)));
      }
    }
    for (const f of ['TICKET.md', 'SUMMARY.md', 'COVERAGE.md']) {
      if (existsSync(join(out, f))) return send(res, 200, 'text/plain; charset=utf-8', readFileSync(join(out, f)));
    }
    return send(res, 404, 'text/plain', 'No report for this run yet.');
  }
}

function publicJob(j: QueuedJob) {
  return { id: j.id, kind: j.kind, label: j.label, state: j.state, queuedAt: j.queuedAt, startedAt: j.startedAt, finishedAt: j.finishedAt, outcome: j.outcome, log: j.log.slice(-15) };
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys.at(-1)!] = value;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown) {
  send(res, status, 'application/json', JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
