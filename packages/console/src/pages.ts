import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { envFor, evalStats, type QueuedJob, type Runtime } from '@gatehouse/app';
import { loadConfig, type StoredEvent } from '@gatehouse/core';
import { pendingGate } from '@gatehouse/gates';
import { parseGitHubRemote, type GitHubClient } from '@gatehouse/github';
import { escapeHtml as esc, latestEnv, loadWorkflow } from '@gatehouse/workflows';
import {
  PCI_TEXT,
  WORKFLOW_NAME,
  ago,
  badge,
  duration,
  envText,
  friendlyStatus,
  gateInfo,
  progressOf,
  renderFindings,
  renderProgress,
  reviewPackageOf,
  type FriendlyStatus,
} from './ui.ts';
import { eventSummary, gateView, renderStats, runInfo, runStats, type RunInfo } from './views.ts';

export interface PageContext {
  rt: Runtime;
  csrf: string;
  projectDir: string;
  /** Whether a console job is working on this run right now. */
  activeRun(runId: string): 'queued' | 'running' | null;
  jobs(): QueuedJob[];
  github(): Promise<GitHubClient | null>;
}

type NavKey = 'home' | 'prs' | 'new' | 'repos' | 'settings' | '';

export function layout(ctx: PageContext, title: string, body: string, nav: NavKey): string {
  const items: Array<[NavKey, string, string]> = [['home', '/', 'Home'], ['prs', '/prs', 'Pull requests'], ['new', '/new', 'New task'], ['repos', '/repos', 'Repositories'], ['settings', '/settings', 'Settings']];
  const waiting = allRuns(ctx).filter((r) => r.gate || r.status === 'blocked').length;
  const links = items.map(([k, href, label]) => `<a href="${href}"${k === nav ? ' aria-current="page"' : ''}>${label}${k === 'home' && waiting ? ` <span class="count">${waiting}</span>` : ''}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf" content="${ctx.csrf}"><title>${esc(title)} · Gatehouse</title><style>${CSS}</style></head>
<body><header class="top"><a href="/" class="brand"><span class="logo">⛩</span> Gatehouse</a><nav>${links}</nav></header><main>${body}</main>
<script src="/static/webauthn.js"></script><script src="/static/app.js"></script></body></html>`;
}

// ---- shared data ------------------------------------------------------------------------------------

export function allRuns(ctx: PageContext): RunInfo[] {
  const { rt } = ctx;
  const ids = rt.events.runs().filter((r) => /^(prr|brr|tkt|lgt|onboard)-/.test(r) && !r.endsWith('--review'));
  const current = new Set(rt.repos.list().map((r) => latestEnv(rt.events, rt.artifacts, r.name).onboardRun));
  return ids
    .map((id) => {
      const info = runInfo(rt.events, id);
      return info.workflow === 'env-onboarding' && info.gate && !current.has(id) ? { ...info, gate: null, status: 'superseded', cls: '' } : info;
    })
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

function statusOf(ctx: PageContext, info: RunInfo, events?: StoredEvent[]): FriendlyStatus {
  const list = events ?? ctx.rt.events.list(info.id);
  const questions = list.some((e) => e.type === 'BLOCKING_QUESTIONS');
  return friendlyStatus(info, ctx.activeRun(info.id), questions);
}

/** Title without the internal workflow prefix, plus a short kind label. */
function shortTitle(info: RunInfo): string {
  return info.title.replace(/^[^:]+:\s*/, '');
}

function oneLineResult(ctx: PageContext, info: RunInfo, events: StoredEvent[]): string {
  if (info.workflow === 'pr-review') {
    const pkg = reviewPackageOf(events, ctx.rt.artifacts);
    if (!pkg) return '';
    const posted = pkg.findings.filter((f) => f.verdict === 'STANDS' || f.verdict === 'UNCHALLENGED');
    const crit = posted.filter((f) => f.severity === 'P1').length;
    return `${posted.length} finding${posted.length === 1 ? '' : 's'}${crit ? `, ${crit} critical` : ''}${pkg.incomplete ? ' · incomplete' : ''}`;
  }
  if (info.workflow === 'env-onboarding') {
    const v = events.filter((e) => e.type === 'ENV_VERIFIED').at(-1)?.payload as { level?: string } | undefined;
    return v?.level === 'L2' ? 'builds and tests run' : v?.level === 'L1' ? 'builds; tests do not run' : v ? 'does not build yet' : '';
  }
  return '';
}

function runCard(ctx: PageContext, info: RunInfo, action?: string): string {
  const events = ctx.rt.events.list(info.id);
  const st = statusOf(ctx, info, events);
  const gate = info.gate ? gateInfo(info.workflow, info.gate.gate) : null;
  const result = oneLineResult(ctx, info, events);
  return `<a class="card run" href="/runs/${esc(info.id)}"><div class="row"><span class="kind">${esc(WORKFLOW_NAME[info.workflow] ?? info.workflow)}</span>${badge(st)}</div>
<div class="title">${esc(shortTitle(info))}</div>
<div class="muted small">${gate ? esc(gate.title) + ' · ' : ''}${result ? esc(result) + ' · ' : ''}${esc(ago(info.updated))}</div>${action ? `<div class="cta">${esc(action)} →</div>` : ''}</a>`;
}

// ---- home ---------------------------------------------------------------------------------------------

export function homePage(ctx: PageContext): string {
  const { rt } = ctx;
  const runs = allRuns(ctx);
  const repos = rt.repos.list();
  const envs = repos.map((r) => latestEnv(rt.events, rt.artifacts, r.name));
  const tokenSet = rt.secrets.list().includes(rt.config.github.tokenSecret);
  const envApprovedAny = runs.some((r) => r.workflow === 'env-onboarding' && rt.events.list(r.id).some((e) => e.type === 'GATE_DECISION' && (e.payload as { decision?: string }).decision === 'approve'));
  const setup: Array<{ done: boolean; title: string; text: string; href: string; cta: string }> = [
    { done: rt.approvers.list().length > 0, title: 'Register your passkey', text: 'Every approval is signed with Windows Hello / Touch ID, so nothing is posted without you. Run `gatehouse approver enroll` in a terminal to get a one-time code.', href: '/approvers', cta: 'Register' },
    { done: tokenSet, title: 'Connect GitHub', text: 'A fine-grained token lets Gatehouse read pull requests and post the reviews you approve.', href: '/settings#secrets', cta: 'Add token' },
    { done: repos.length > 0, title: 'Add a repository', text: 'Gatehouse works on its own copy; your checkout is never touched.', href: '/repos', cta: 'Add' },
    { done: envs.some((e) => e.level !== 'L0'), title: 'Check how it builds and tests', text: 'Gatehouse reads the build files and CI, then builds and runs the tests once.', href: '/repos', cta: 'Check' },
    { done: envApprovedAny, title: 'Approve the build & test setup', text: 'Lets Gatehouse prove findings with tests and implement tickets test-first.', href: '/repos', cta: 'Review' },
  ];
  const todo = setup.filter((s) => !s.done);
  const setupHtml = todo.length
    ? `<section class="setup"><h2>Get started <span class="muted small">${setup.length - todo.length} of ${setup.length} done</span></h2><ol>${setup
        .map((s) => `<li class="${s.done ? 'done' : ''}"><span class="dot">${s.done ? '✓' : ''}</span><div><strong>${esc(s.title)}</strong><div class="muted small">${esc(s.text)}</div></div>${s.done ? '' : `<a class="btn" href="${s.href}">${esc(s.cta)}</a>`}</li>`)
        .join('')}</ol></section>`
    : '';
  const needs = runs.filter((r) => r.gate || (r.status === 'blocked' && rt.events.list(r.id).some((e) => e.type === 'BLOCKING_QUESTIONS')));
  const failed = runs.filter((r) => r.status === 'failed' && !ctx.activeRun(r.id)).slice(0, 3);
  const recent = runs.filter((r) => !needs.includes(r) && !ctx.activeRun(r.id)).slice(0, 12);
  return `<h1>Home</h1>
${setupHtml}
<section><h2>Needs you</h2>${needs.length ? `<div class="cards">${needs.map((r) => runCard(ctx, r, r.gate ? 'Review and decide' : 'Answer')).join('')}</div>` : '<p class="empty">Nothing needs you right now.</p>'}</section>
<section id="live" data-live="/api/live"><h2>In progress</h2>${homeLive(ctx).html}</section>
${failed.length ? `<section><h2>Stopped with an error</h2><div class="cards">${failed.map((r) => runCard(ctx, r, 'See what happened')).join('')}</div></section>` : ''}
<section><h2>Recent</h2>${recent.length ? `<table class="list"><tbody>${recent
    .map((r) => {
      const st = statusOf(ctx, r);
      return `<tr><td><a href="/runs/${esc(r.id)}">${esc(shortTitle(r))}</a><div class="muted small">${esc(WORKFLOW_NAME[r.workflow] ?? r.workflow)}</div></td><td>${badge(st)}</td><td class="muted small num">${esc(ago(r.updated))}</td></tr>`;
    })
    .join('')}</tbody></table>` : '<p class="empty">No runs yet. Review a pull request from <a href="/prs">Pull requests</a>.</p>'}</section>`;
}

/** The "In progress" block, also served live (key changes when a job starts or ends). */
export function homeLive(ctx: PageContext): { key: string; html: string } {
  const active = ctx.jobs().filter((j) => j.state === 'queued' || j.state === 'running');
  const key = active.map((j) => `${j.id}:${j.state}`).join(',');
  if (!active.length) return { key, html: '<p class="empty">Nothing is running.</p>' };
  const html = `<div class="cards">${active
    .map((j) => {
      const runId = (j as QueuedJob & { runId?: string }).runId;
      const events = runId ? ctx.rt.events.list(runId) : [];
      const info = runId && events.length ? runInfo(ctx.rt.events, runId) : null;
      const pr = info ? progressOf(events, info.workflow) : null;
      const body = j.state === 'queued' ? '<p class="muted small">Waiting for another run on this repository to finish.</p>' : pr ? `<div class="pbar"><span style="width:${pr.pct}%"></span></div><p class="muted small">${pr.done}/${pr.total} steps · ${duration(pr.elapsedMs)}${pr.current ? ` · ${esc(pr.current)}` : ''}</p>` : '<p class="muted small">Starting…</p>';
      return `<a class="card run" href="${runId ? `/runs/${esc(runId)}` : '/'}"><div class="row"><span class="kind">${esc(WORKFLOW_NAME[j.kind] ?? j.kind)}</span>${badge({ key: j.state, text: j.state === 'queued' ? 'Waiting to start' : 'Running', cls: 'run' })}</div><div class="title">${esc(j.label)}</div>${body}</a>`;
    })
    .join('')}</div>`;
  return { key, html };
}

// ---- pull requests ---------------------------------------------------------------------------------

export async function prsPage(ctx: PageContext): Promise<string> {
  const { rt } = ctx;
  const gh = await ctx.github().catch(() => null);
  const me = gh ? await gh.me().catch(() => null) : null;
  // Latest Gatehouse review per PR.
  const byPr = new Map<string, RunInfo>();
  for (const r of allRuns(ctx).filter((x) => x.workflow === 'pr-review')) {
    const s = (rt.events.list(r.id).find((e) => e.type === 'RUN_STARTED')?.payload ?? {}) as Record<string, any>;
    const src = s.source ?? s;
    if (src.number) {
      const key = `${src.owner}/${src.repoName}#${src.number}`;
      if (!byPr.has(key)) byPr.set(key, r);
    }
  }
  const sections: string[] = [];
  for (const repo of rt.repos.list()) {
    const remote = parseGitHubRemote(repo.source);
    if (!remote || !gh) continue;
    let rows = '';
    try {
      const prs = await gh.listOpenPulls(remote.owner, remote.repo);
      rows = prs
        .map((pr) => {
          const tag = me && pr.reviewers.includes(me) ? '<span class="tag warn">review requested</span>' : me && pr.author === me ? '<span class="tag">yours</span>' : '';
          const run = byPr.get(`${remote.owner}/${remote.repo}#${pr.number}`);
          const st = run ? statusOf(ctx, run) : null;
          const action = run
            ? `<a class="btn" href="/runs/${esc(run.id)}">Open review</a>`
            : `<button class="primary" data-job="review" data-repo="${esc(repo.name)}" data-pr="${pr.number}">Review</button>`;
          return `<tr><td><a href="${esc(pr.url)}" rel="noreferrer" target="_blank">#${pr.number}</a> ${esc(pr.title)} ${pr.draft ? '<span class="tag">draft</span>' : ''}${tag}<div class="muted small">${esc(pr.author)} · updated ${esc(ago(pr.updated))}</div></td>
<td>${st ? `${badge(st)}<div class="muted small">${esc(oneLineResult(ctx, run!, rt.events.list(run!.id)))}</div>` : '<span class="muted small">Not reviewed</span>'}</td><td class="num">${action}</td></tr>`;
        })
        .join('');
    } catch (err) {
      rows = `<tr><td colspan="3" class="muted">Could not list pull requests: ${esc((err as Error).message)}</td></tr>`;
    }
    sections.push(`<section><h2>${esc(repo.name)} <span class="muted small">${esc(remote.owner)}/${esc(remote.repo)}</span></h2>${rows ? `<table class="list"><thead><tr><th>Pull request</th><th>Gatehouse</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No open pull requests.</p>'}</section>`);
  }
  const intro = '<p class="lead">Pick a pull request and press <strong>Review</strong>. Gatehouse reviews it in the background (usually 5–30 minutes depending on size) and nothing is posted until you approve.</p>';
  const who = gh ? (me ? `<p class="muted small">Signed in to GitHub as ${esc(me)}.</p>` : '<p class="muted small">No GitHub token: only public repositories are listed. <a href="/settings#secrets">Add a token</a>.</p>') : '';
  return `<h1>Pull requests</h1>${intro}${who}${sections.join('') || '<p class="empty">No GitHub repositories yet. <a href="/repos">Add one</a>.</p>'}<p id="job-status" role="status"></p>`;
}

// ---- new task -------------------------------------------------------------------------------------------

export function newPage(ctx: PageContext): string {
  const opts = ctx.rt.repos.list().map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  if (!opts) return '<h1>New task</h1><p class="empty">Add a repository first on the <a href="/repos">Repositories</a> page.</p>';
  const card = (title: string, what: string, approve: string, form: string) => `<section class="task"><h2>${title}</h2><p>${what}</p><p class="muted small">You approve: ${approve}</p>${form}</section>`;
  return `<h1>New task</h1><p class="lead">Each task runs in the background. You will be asked to approve at the important points; nothing reaches GitHub without your passkey.</p>
<div class="tasks">
${card('Implement a ticket', 'Turns a ticket into a backlog item, specification, plan and tasks, then implements it test-first and opens a draft pull request.', 'the backlog item, spec, plan, tasks and the final change.', `<form data-form="ticket"><label>Repository<select name="repo">${opts}</select></label><label>Ticket key<input name="ticket" placeholder="SHOP-123" required></label><label>Ticket text <span class="muted">(only if no tracker is connected)</span><textarea name="text" rows="4"></textarea></label><button class="primary">Start</button></form>`)}
${card('Add tests to legacy code', 'Finds the riskiest classes with little coverage and writes tests that pin their current behaviour. Production code is never changed.', 'which classes, the scenarios, the tests and the draft PR.', `<form data-form="legacy"><label>Repository<select name="repo">${opts}</select></label><label>Only this package <span class="muted">(optional)</span><input name="scope" placeholder="com.acme.pricing"></label><label>How many classes<input name="top" type="number" value="3" min="1" max="10"></label><button class="primary">Start</button></form>`)}
${card('Review a branch before opening a PR', 'Same review as for pull requests, on any pushed branch. Results stay here; nothing is posted.', 'nothing, it is only a report.', `<form data-form="branch-review"><label>Repository<select name="repo">${opts}</select></label><label>Branch<input name="head" placeholder="feature/x" required></label><label>Compare with <span class="muted">(default branch if empty)</span><input name="base"></label><button class="primary">Start</button></form>`)}
</div><p id="job-status" role="status"></p>`;
}

// ---- repositories -------------------------------------------------------------------------------------

export async function reposPage(ctx: PageContext): Promise<string> {
  const { rt } = ctx;
  const cards: string[] = [];
  for (const r of rt.repos.list()) {
    const env = await envFor(rt, r.name);
    const latest = latestEnv(rt.events, rt.artifacts, r.name);
    const checking = ctx.jobs().some((j) => (j.state === 'queued' || j.state === 'running') && j.kind === 'env-onboarding' && j.label.includes(r.name));
    const e = envText(env, checking);
    const gate = latest.onboardRun ? pendingGate(rt.events, latest.onboardRun) : null;
    cards.push(`<section class="repo"><div class="row"><h2>${esc(r.name)}</h2><span class="tag">${esc(PCI_TEXT[r.pciScope] ?? r.pciScope)}</span></div>
<p class="muted small"><a href="${esc(r.source)}" rel="noreferrer" target="_blank">${esc(r.source)}</a> · default branch ${esc(r.defaultBranch)}</p>
<div class="envline"><span class="badge ${e.cls}">${e.cls === 'run' ? '<span class="spin"></span>' : ''}${esc(e.text)}</span>${latest.onboardRun ? ` <a href="/runs/${esc(latest.onboardRun)}">${gate ? 'Review and approve' : 'Details'}</a>` : ''}</div>
<p class="muted small">${esc(e.hint)}</p>
<div class="actions"><button data-job="onboard" data-repo="${esc(r.name)}" data-target="host" title="Uses the JDK/Maven/Node already installed on this computer">Check on this computer</button><button data-job="onboard" data-repo="${esc(r.name)}" data-target="cell" title="Runs builds and tests in a locked-down Docker container without network">Check in a sandbox</button></div></section>`);
  }
  return `<h1>Repositories</h1><p class="lead">Gatehouse keeps its own copy of each repository. “Check” works out how the project builds and tests and runs it once, so Gatehouse can later run tests itself.</p>
${cards.join('') || '<p class="empty">No repositories yet.</p>'}
<p id="job-status" role="status"></p>
<section class="task"><h2>Add a repository</h2><form data-form="repo"><label>GitHub URL<input name="source" placeholder="https://github.com/owner/repo.git" required></label><label>Short name <span class="muted">(optional)</span><input name="name"></label>
<label>PCI scope<select name="pci"><option value="out">Not in PCI scope</option><option value="connected">Connected to cardholder data systems</option><option value="cde">Handles cardholder data</option></select></label><p class="muted small">With the current AI providers, only repositories outside PCI scope can be processed.</p><button class="primary">Add repository</button></form></section>`;
}

// ---- run detail -----------------------------------------------------------------------------------------

function nextStep(ctx: PageContext, info: RunInfo, st: FriendlyStatus, events: StoredEvent[]): string {
  const p = (e: StoredEvent) => (e.payload ?? {}) as Record<string, any>;
  if (st.key === 'queued') return `<section class="next run"><h2>Waiting to start</h2><p>Another run on this repository is in progress; this one starts right after it.</p></section>`;
  if (st.key === 'running') return `<section class="next run"><h2>Working on it</h2><p>You can leave this page; the run continues in the background. This page updates by itself.</p></section>`;
  if (info.gate) {
    const g = gateInfo(info.workflow, info.gate.gate);
    const pkg = info.workflow === 'pr-review' ? reviewPackageOf(events, ctx.rt.artifacts) : null;
    const target = pkg?.pr ? ` <a href="${esc(pkg.pr.url)}" rel="noreferrer" target="_blank">${esc(pkg.pr.owner)}/${esc(pkg.pr.repo)}#${pkg.pr.number}</a>` : '';
    const approvers = ctx.rt.approvers.list().length;
    return `<section class="next warn decide"><h2>${esc(g.title)}</h2><p>${esc(g.explain)}${target ? ` Destination:${target}.` : ''}</p>
${approvers ? '' : '<div class="notice bad">Register your passkey first (<a href="/approvers">Passkeys</a>); approvals must be signed.</div>'}
<label>Note <span class="muted">(optional; for a rejection, tell Gatehouse what to change)</span><textarea id="reason" rows="2"></textarea></label>
<div class="actions"><button class="primary" data-decide="approve" data-run="${esc(info.id)}"${approvers ? '' : ' disabled'}>${esc(g.approve)}</button><button data-decide="reject" data-run="${esc(info.id)}"${approvers ? '' : ' disabled'}>${esc(g.reject)}</button></div>
<p class="muted small">Your passkey signs exactly what is shown below; if it changes, the approval no longer counts.</p><p id="gate-status" role="status"></p></section>`;
  }
  if (st.key === 'questions') {
    const q = events.filter((e) => e.type === 'BLOCKING_QUESTIONS').at(-1);
    const qs = (q ? p(q).questions : []) as Array<{ id: string; question: string }>;
    return `<section class="next warn"><h2>Gatehouse needs an answer</h2><p>The ticket leaves these questions open. Your answers are added to the ticket and the run continues.</p>${qs
      .map((x) => `<form data-form="answer" data-run="${esc(info.id)}"><input type="hidden" name="q" value="${esc(x.id)}"><label>${esc(x.question)}<textarea name="answer" rows="2" required></textarea></label><button class="primary">Answer and continue</button></form>`)
      .join('')}</section>`;
  }
  if (st.key === 'published') {
    const pub = events.filter((e) => e.type === 'PUBLISHED').at(-1);
    return `<section class="next ok"><h2>Done</h2><p>Posted: <a href="${esc(String(pub ? p(pub).url : ''))}" rel="noreferrer" target="_blank">${esc(String(pub ? p(pub).url : ''))}</a></p></section>`;
  }
  const final = info.workflow === 'env-onboarding' ? 'GATE_ENV' : (() => { try { return loadWorkflow(info.workflow).finalGate; } catch { return undefined; } })();
  const last = events.filter((e) => e.type === 'GATE_DECISION').at(-1);
  if (last && p(last).decision === 'approve' && p(last).gate === final && info.workflow !== 'env-onboarding') {
    const why = events.filter((e) => /PUBLISH_(REFUSED|FAILED)/.test(e.type)).at(-1);
    return `<section class="next bad"><h2>Approved, but not posted yet</h2><p>${why ? esc(String(p(why).reason ?? p(why).error ?? '')) : 'Publishing did not finish.'}</p><div class="actions"><button class="primary" data-publish="${esc(info.id)}">Try posting again</button></div><p id="gate-status" role="status"></p></section>`;
  }
  if (st.key === 'approved') return `<section class="next ok"><h2>Approved</h2><p>Later runs on this repository use this build &amp; test setup.</p></section>`;
  if (st.key === 'done') return `<section class="next ok"><h2>Finished</h2><p>${info.workflow === 'pr-review' ? 'This was a local review; nothing was posted.' : 'Nothing else to do.'}</p></section>`;
  if (st.key === 'rejected') return `<section class="next"><h2>You rejected this</h2><p>Nothing was posted. You can retry a step with feedback in the Activity tab.</p></section>`;
  if (st.key === 'denied') {
    const d = events.find((e) => e.type === 'POLICY_DENIED');
    return `<section class="next bad"><h2>Not allowed by policy</h2><p>${esc(((d ? p(d).reasons : []) as string[]).join(' '))}</p></section>`;
  }
  if (st.key === 'superseded') return `<section class="next"><h2>Replaced</h2><p>A newer check of this repository exists; approve that one instead (Repositories page).</p></section>`;
  const failure = events.filter((e) => e.type === 'STEP_FAILED').at(-1);
  const reason = failure ? String(p(failure).error ?? '') : 'The run was interrupted (for example the console was closed).';
  return `<section class="next bad"><h2>${st.key === 'interrupted' ? 'Interrupted' : 'Stopped with an error'}</h2><p>${esc(reason.slice(0, 500))}</p><div class="actions"><button class="primary" data-resume="${esc(info.id)}">Continue where it stopped</button><a class="btn" href="#tab-activity" data-open-tab="activity">Retry a step…</a></div><p id="job-status" role="status"></p></section>`;
}

export function runPage(ctx: PageContext, runId: string): { title: string; html: string } {
  const { rt } = ctx;
  const events = rt.events.list(runId);
  if (!events.length) {
    if (ctx.activeRun(runId)) return { title: 'Starting', html: `<p><a href="/">← Home</a></p><h1>Starting…</h1><section class="next run" data-live="/api/runs/${esc(runId)}/live" data-live-key="queued"><p>The run is queued and starts in a moment.</p></section>` };
    return { title: 'Unknown run', html: '<p class="empty">This run does not exist. <a href="/">Home</a></p>' };
  }
  const info = runInfo(rt.events, runId);
  const st = statusOf(ctx, info, events);
  const started = (events.find((e) => e.type === 'RUN_STARTED')?.payload ?? {}) as Record<string, any>;
  const live = st.key === 'running' || st.key === 'queued';
  const pr = progressOf(events, info.workflow);
  const pkg = info.workflow === 'pr-review' ? reviewPackageOf(events, rt.artifacts) : null;

  // Tab 1: what was produced (findings, or the artifact a gate is about).
  let overview = '';
  if (pkg) overview = renderFindings(pkg);
  else if (info.gate) overview = `<div class="artifact">${gateView(rt.artifacts, info.workflow, info.gate.gate, info.gate.artifact)}</div>`;
  else if (info.workflow === 'env-onboarding') {
    const ask = events.filter((e) => e.type === 'AWAITING_GATE').at(-1)?.payload as { artifact?: string } | undefined;
    overview = ask?.artifact ? `<div class="artifact">${gateView(rt.artifacts, info.workflow, 'GATE_ENV', ask.artifact)}</div>` : '';
  }
  const report = existsSync(join(rt.paths.runs, runId, 'out', 'review.html')) || existsSync(join(rt.paths.runs, runId, 'out', 'coverage-report.html'));

  // Tab 3: activity (retry + raw log).
  let retry = '';
  if (info.workflow !== 'env-onboarding' && !live) {
    try {
      const stages = loadWorkflow(info.workflow).steps.filter((s) => s.kind !== 'gate');
      retry = `<section class="task"><h3>Retry a step</h3><p class="muted small">Runs the step again and everything after it. Use the note to tell the agent what to do differently.</p><form data-form="retry" data-run="${esc(runId)}"><label>Start again from<select name="stage">${stages.map((s) => `<option value="${esc(s.id)}">${esc(progressOf([], info.workflow).steps.find((x) => x.id === s.id)?.label ?? s.id)}</option>`).join('')}</select></label><label>Note for the agent <span class="muted">(optional)</span><textarea name="note" rows="2"></textarea></label><button>Retry</button></form></section>`;
    } catch {
      retry = '';
    }
  }
  const t0 = Date.parse(events[0]!.ts);
  const row = (e: StoredEvent) => `<tr${e.type === 'MODEL_CALL' ? ' class="mc"' : ''}><td class="num mono">+${((Date.parse(e.ts) - t0) / 1000).toFixed(1)}s</td><td class="mono">${esc(e.type)}</td><td>${esc(eventSummary(e))}</td></tr>`;
  const modelCalls = events.filter((e) => e.type === 'MODEL_CALL').length;
  const chain = rt.events.verify(runId);
  const children = events.filter((e) => e.type === 'CHILD_RUN').map((e) => String((e.payload as { runId: string }).runId));
  const activity = `${retry}
<h3>Technical details</h3><dl class="kv"><dt>Run id</dt><dd class="mono">${esc(runId)}</dd><dt>Audit log</dt><dd>${events.length} events, hash chain ${chain.ok ? 'intact' : '<strong>BROKEN</strong>'}</dd>${children.length ? `<dt>Sub-runs</dt><dd>${children.map((c) => `<a href="/runs/${esc(c)}">${esc(c)}</a>`).join(', ')}</dd>` : ''}</dl>
<details><summary>Run input</summary><pre>${esc(JSON.stringify(started, null, 2))}</pre></details>
<details><summary>Full event log (${events.length})</summary>${modelCalls ? `<p><label class="inline"><input type="checkbox" id="show-mc"> include the ${modelCalls} model calls</label></p>` : ''}<table class="trace hide-mc"><tbody>${events.map(row).join('')}</tbody></table></details>`;

  const tabs: Array<[string, string, string]> = [
    ...(overview ? [['result', pkg ? `Findings (${pkg.findings.filter((f) => f.verdict === 'STANDS' || f.verdict === 'UNCHALLENGED').length})` : info.gate || info.workflow === 'env-onboarding' ? 'What you approve' : 'Result', overview] as [string, string, string]] : []),
    ['progress', 'Progress & cost', `<div id="progress"${live ? ` data-live="/api/runs/${esc(runId)}/live" data-live-key="${esc(st.key)}"` : ''}>${renderProgress(pr, live)}</div>${renderStats(runStats(events))}`],
    ['activity', 'Activity', activity],
  ];
  const first = live || !overview ? 'progress' : 'result';
  const html = `<p class="crumbs"><a href="/">← Home</a></p>
<div class="runhead"><div><span class="kind">${esc(WORKFLOW_NAME[info.workflow] ?? info.workflow)}</span><h1>${esc(shortTitle(info))}</h1><p class="muted small">${esc(String(started.repo ?? ''))} · started ${esc(ago(events[0]!.ts))}${report ? ` · <a href="/runs/${esc(runId)}/report" target="_blank">printable report</a>` : ''}</p></div>${badge(st)}</div>
${nextStep(ctx, info, st, events)}
<nav class="tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === first}">${esc(label)}</button>`).join('')}</nav>
${tabs.map(([id, , body]) => `<section class="tabpanel" id="tab-${id}" data-panel="${id}"${id === first ? '' : ' hidden'}>${body}</section>`).join('')}`;
  return { title: shortTitle(info), html };
}

/** Live fragment for a running run: progress block, plus a key that changes when the status does. */
export function runLive(ctx: PageContext, runId: string): { key: string; html: string } {
  const events = ctx.rt.events.list(runId);
  if (!events.length) return { key: ctx.activeRun(runId) ? 'queued' : 'gone', html: '' };
  const info = runInfo(ctx.rt.events, runId);
  const st = statusOf(ctx, info, events);
  return { key: st.key, html: renderProgress(progressOf(events, info.workflow), st.key === 'running') };
}

// ---- settings -------------------------------------------------------------------------------------------

interface Field {
  path: string;
  label: string;
  help: string;
  kind: 'text' | 'number' | 'bool' | 'select';
  options?: Array<[string, string]>;
}

const FIELDS: Array<{ group: string; fields: Field[] }> = [
  {
    group: 'Reviews',
    fields: [
      { path: 'llm.budgetTokensPerRun', label: 'Token budget per run', help: 'A large pull request (~2,000 lines) needs about 15 million tokens. Units started after the budget is spent are reported as not reviewed.', kind: 'number' },
      { path: 'review.maxWorkers', label: 'Review passes in parallel', help: 'More is faster but sends more requests to the model provider at once.', kind: 'number' },
      { path: 'review.maxUnitLines', label: 'Lines per review pass', help: 'Large changes are split into passes of at most this many changed lines.', kind: 'number' },
      { path: 'review.stepTimeoutMinutes', label: 'Time limit per agent step (minutes)', help: '', kind: 'number' },
      { path: 'executors.codex.enabled', label: 'Second opinion with Codex', help: 'An independent model challenges critical and high findings.', kind: 'bool' },
      { path: 'review.ticketTool', label: 'Ticket lookup tool', help: 'Format server:tool:argument, e.g. tracker:jira_get_issue:issue_key. Leave empty without a tracker.', kind: 'text' },
    ],
  },
  {
    group: 'Where builds and tests run',
    fields: [
      { path: 'runtime.target', label: 'Default for new checks', help: 'A repository keeps using the place where its setup was approved.', kind: 'select', options: [['host', 'This computer'], ['cell', 'Sandbox container (Docker)']] },
      { path: 'scheduler.maxParallelRuns', label: 'Runs at the same time', help: 'Runs on the same repository always wait for each other.', kind: 'number' },
      { path: 'cell.runtime', label: 'Sandbox isolation', help: 'runc is standard Docker; gVisor (runsc) and Kata isolate better but must be installed first.', kind: 'select', options: [['runc', 'Standard Docker (runc)'], ['runsc', 'gVisor (runsc)'], ['kata', 'Kata containers']] },
      { path: 'cell.cpus', label: 'Sandbox CPUs', help: '', kind: 'number' },
      { path: 'cell.memoryGb', label: 'Sandbox memory (GB)', help: '', kind: 'number' },
    ],
  },
  {
    group: 'Agents and GitHub',
    fields: [
      { path: 'executors.copilot.enabled', label: 'Use Copilot CLI', help: 'Required for reviews and implementation.', kind: 'bool' },
      { path: 'executors.codex.model', label: 'Codex model', help: '', kind: 'text' },
      { path: 'github.apiUrl', label: 'GitHub API URL', help: 'Change only for GitHub Enterprise.', kind: 'text' },
      { path: 'console.port', label: 'Console port', help: 'Takes effect after restarting `gatehouse serve`. Passkeys are tied to the port.', kind: 'number' },
    ],
  },
];
const RECORD_PATHS = ['llm.providers', 'llm.tiers', 'mcp.servers'];

function settingsTabs(active: string): string {
  return `<nav class="subnav">${[['/settings', 'General'], ['/settings#secrets', 'Secrets'], ['/approvers', 'Passkeys'], ['/evals', 'Quality']].map(([href, label]) => `<a href="${href}"${label === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

export function settingsPage(ctx: PageContext): string {
  const { rt } = ctx;
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({ projectDir: ctx.projectDir });
  } catch (err) {
    return `<h1>Settings</h1><div class="notice bad">The configuration is invalid: ${esc((err as Error).message)}</div>`;
  }
  const { config, sources } = loaded;
  const get = (path: string) => path.split('.').reduce<unknown>((c, k) => (c as Record<string, unknown> | undefined)?.[k], config);
  const from = (path: string) => ({ default: 'default', team: 'team file', machine: 'this computer', env: 'environment variable', override: 'override' })[sources[path] ?? 'default'] ?? sources[path];
  const input = (f: Field) => {
    const v = get(f.path);
    if (f.kind === 'bool') return `<label class="check"><input type="checkbox" name="${esc(f.path)}" data-kind="json"${v ? ' checked' : ''}> ${esc(f.label)}</label>`;
    if (f.kind === 'select') return `<label>${esc(f.label)}<select name="${esc(f.path)}">${(f.options ?? []).map(([val, text]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
    return `<label>${esc(f.label)}<input name="${esc(f.path)}" ${f.kind === 'number' ? 'type="number" data-kind="json"' : 'data-kind="string"'} value="${esc(String(v ?? ''))}"></label>`;
  };
  const known = new Set(FIELDS.flatMap((g) => g.fields.map((f) => f.path)));
  const general = FIELDS.map((g) => `<fieldset><legend>${esc(g.group)}</legend>${g.fields.map((f) => `<div class="field">${input(f)}<div class="muted small">${esc(f.help)}${f.help ? ' · ' : ''}set by ${esc(from(f.path))}</div></div>`).join('')}</fieldset>`).join('');
  const rest = Object.keys(sources).filter((p) => !known.has(p) && !RECORD_PATHS.includes(p) && p !== 'paths.home');
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
  const advanced = `<details class="advanced"><summary>Advanced (all settings)</summary>${rest.map((p) => `<label class="mono small">${esc(p)} <span class="muted">[${esc(from(p))}]</span><input name="${esc(p)}" data-kind="${typeof get(p) === 'string' ? 'string' : 'json'}" value="${esc(show(get(p)))}"></label>`).join('')}
${RECORD_PATHS.map((p) => `<label class="mono small">${esc(p)} <span class="muted">[${esc(from(p))}] JSON, merged with lower layers</span><textarea name="${esc(p)}" data-kind="json" rows="7">${esc(JSON.stringify(get(p) ?? {}, null, 2))}</textarea></label>`).join('')}</details>`;
  const secrets = rt.secrets.list();
  const want = [
    [rt.config.github.tokenSecret, 'GitHub token', 'Fine-grained token: Pull requests read & write, Contents read (read & write to open draft PRs).'],
    ...Object.entries(rt.config.llm.providers).map(([name, p]) => [p.keySecret, `${name} API key`, `Used by the model gateway for ${name}.`]),
  ];
  return `<h1>Settings</h1>${settingsTabs('General')}
<p class="lead">Changes are saved on this computer (${esc(rt.paths.machineConfig)}) and confirmed with your passkey.</p>
<form data-form="settings">${general}${advanced}<div class="actions sticky"><button class="primary">Save changes</button><span id="settings-status" role="status" class="muted small"></span></div></form>
<section class="task" id="secrets"><h2>Secrets</h2><p class="muted small">Stored with ${esc(rt.secrets.backend)}. Values are never shown again and never given to agents.</p>
<table class="list"><tbody>${want.map(([name, label, help]) => `<tr><td><strong>${esc(String(label))}</strong><div class="muted small">${esc(String(help))} <span class="mono">${esc(String(name))}</span></div></td><td>${secrets.includes(String(name)) ? '<span class="badge ok">set</span>' : '<span class="badge warn">missing</span>'}</td></tr>`).join('')}</tbody></table>
<form data-form="secret"><label>Name<input name="name" placeholder="${esc(rt.config.github.tokenSecret)}" required list="secret-names"></label><datalist id="secret-names">${want.map(([n]) => `<option value="${esc(String(n))}">`).join('')}</datalist><label>Value<input name="value" type="password" autocomplete="off" required></label><button class="primary">Save secret</button></form></section>`;
}

export function evalsPage(ctx: PageContext): string {
  const blocks = ['pr-review', 'ticket', 'legacy-tests'].map((wf) => {
    const s = evalStats(ctx.rt, wf);
    if (!s.runs) return `<section class="task"><h2>${esc(WORKFLOW_NAME[wf] ?? wf)}</h2><p class="empty">No decisions yet.</p></section>`;
    const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '—';
    return `<section class="task"><h2>${esc(WORKFLOW_NAME[wf] ?? wf)}</h2><div class="summary-line"><div><span class="big">${s.runs}</span> decisions</div><div><span class="big">${s.runs ? Math.round((s.approved / s.runs) * 100) : 0}%</span> approved</div><div><span class="big">${s.findings}</span> findings</div><div><span class="big">${Math.round(s.avgTokens / 1000)}k</span> tokens per run</div></div><p class="muted small">By verdict: ${kv(s.byVerdict)}<br>By evidence: ${kv(s.byEvidence)}</p></section>`;
  });
  return `<h1>Quality</h1>${settingsTabs('Quality')}<p class="lead">Each final approval or rejection is kept as a labelled example, to measure whether changes to prompts, models or rules make Gatehouse better.</p>${blocks.join('')}`;
}

export function approversPage(ctx: PageContext): string {
  const list = ctx.rt.approvers.list();
  return `<h1>Passkeys</h1>${settingsTabs('Passkeys')}
<p class="lead">Approvals are signed with a passkey on this device (Windows Hello, Touch ID or a security key). Gatehouse refuses to publish anything without a valid signature.</p>
${list.length ? `<table class="list"><thead><tr><th>Name</th><th>Added</th></tr></thead><tbody>${list.map((a) => `<tr><td>${esc(a.name)} <span class="muted small mono">${esc(a.credentialId.slice(0, 10))}…</span></td><td class="muted small">${esc(a.createdAt.slice(0, 10))}</td></tr>`).join('')}</tbody></table><p class="muted small">Adding another passkey needs confirmation from one of these.</p>` : ''}
<section class="task"><h2>${list.length ? 'Add another passkey' : 'Register your passkey'}</h2><ol class="howto"><li>In a terminal, run <code>gatehouse approver enroll</code>. It prints a one-time code (valid 10 minutes).</li><li>Enter the code and your name below, then confirm with your device.</li></ol>
<label>One-time code<input id="enroll-code" autocomplete="off" placeholder="ABCD-EF12-3456"></label><label>Your name<input id="enroll-name" placeholder="name"></label>
<div class="actions"><button class="primary" id="enroll">Register this device</button></div><p id="enroll-status" role="status"></p></section>`;
}

export const CSS = `
:root{--bg:#f6f6f3;--fg:#1b1b19;--muted:#6b6b65;--line:#e0e0da;--card:#fff;--accent:#2f5d50;--accent-fg:#fff;--ok:#2f6b3a;--ok-bg:#e8f3ea;--warn:#8a5a00;--warn-bg:#fdf3df;--bad:#9b2c2c;--bad-bg:#fbe9e9;--run:#2c5a9b;--run-bg:#e7eefa;--p1:#b42318;--p2:#c4320a;--p3:#a15c07;--p4:#475467}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#9a9a93;--line:#30302c;--card:#1d1d1b;--accent:#7fbfa9;--accent-fg:#10201b;--ok:#86c994;--ok-bg:#1d2b20;--warn:#e7b85a;--warn-bg:#2d2616;--bad:#f09a9a;--bad-bg:#2e1c1c;--run:#9cbcf0;--run-bg:#1b2333;--p1:#ff8a80;--p2:#ffab70;--p3:#f0c060;--p4:#b0b8c4}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}code,pre,.mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px}
header.top{display:flex;gap:20px;align-items:center;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:5}
.brand{font-weight:700;color:var(--fg);text-decoration:none;font-size:16px}.logo{color:var(--accent)}
nav{display:flex;flex-wrap:wrap;gap:2px}nav a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:6px}nav a:hover{color:var(--fg);background:var(--bg)}nav a[aria-current]{color:var(--fg);background:var(--bg);font-weight:600}
.count{display:inline-block;min-width:18px;padding:0 5px;border-radius:9px;background:var(--warn);color:var(--card);font-size:11px;text-align:center;font-weight:700}
main{max-width:1040px;margin:0 auto;padding:24px 16px 80px}h1{font-size:24px;margin:0 0 6px}h2{font-size:17px;margin:0 0 10px}h3{font-size:15px;margin:16px 0 6px}section{margin:0 0 28px}
.lead{color:var(--muted);margin:0 0 18px;max-width:70ch}.muted{color:var(--muted)}.small{font-size:12.5px}.num{text-align:right;white-space:nowrap}.empty{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:10px;padding:16px;text-align:center}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;color:inherit;text-decoration:none}.card:hover{border-color:var(--accent)}
.card .row,.row{display:flex;justify-content:space-between;align-items:center;gap:8px}.card .title{font-weight:600;margin:6px 0 2px}.cta{margin-top:8px;color:var(--accent);font-weight:600;font-size:13.5px}.kind{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:var(--bg);color:var(--muted);white-space:nowrap}.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.bad{background:var(--bad-bg);color:var(--bad)}.badge.run{background:var(--run-bg);color:var(--run)}
.tag{display:inline-block;padding:0 8px;border-radius:6px;border:1px solid var(--line);font-size:12px;color:var(--muted);margin-left:4px}.tag.warn{color:var(--warn);border-color:currentColor}
.spin{width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
table.list{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}table.list td,table.list th{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}table.list th{font-size:12px;color:var(--muted);font-weight:600}table.list tr:last-child td{border-bottom:0}
.setup{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.setup ol{list-style:none;margin:0;padding:0}.setup li{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}.setup li:first-child{border-top:0}.setup li>div{flex:1}.setup li.done{opacity:.6}
.dot{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:var(--ok)}li.done .dot{border-color:var(--ok);background:var(--ok-bg)}
button,.btn{display:inline-block;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:14px;cursor:pointer;text-decoration:none;white-space:nowrap}button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}button:disabled{opacity:.55;cursor:not-allowed}
label{display:block;margin:10px 0;font-size:13.5px;font-weight:500}label .muted{font-weight:400}textarea,input,select{display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}label.check{display:flex;gap:8px;align-items:center}label.check input,label.inline input{display:inline;width:auto;margin:0}label.inline{display:inline-flex;gap:6px;align-items:center;margin:0 0 0 8px;font-weight:400}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.actions.sticky{position:sticky;bottom:0;background:var(--bg);padding:10px 0;border-top:1px solid var(--line)}
fieldset{border:1px solid var(--line);border-radius:10px;margin:0 0 14px;padding:4px 14px 10px;background:var(--card)}legend{font-weight:700;padding:0 4px}.field{margin-bottom:6px}details.advanced{margin:0 0 14px}details summary{cursor:pointer;font-weight:600;padding:6px 0}
.task,.repo{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.tasks{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.envline{margin:8px 0 2px}
.notice{border-radius:8px;padding:10px 12px;margin:10px 0;background:var(--bg);border:1px solid var(--line);font-size:14px}.notice.bad{background:var(--bad-bg);border-color:transparent;color:var(--fg)}
.crumbs{margin:0 0 8px;font-size:13.5px}.runhead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}.runhead h1{margin:2px 0}
.next{border-radius:12px;padding:16px;border:1px solid var(--line);background:var(--card)}.next.warn{border-color:var(--warn);background:var(--warn-bg)}.next.ok{background:var(--ok-bg);border-color:transparent}.next.bad{background:var(--bad-bg);border-color:transparent}.next.run{background:var(--run-bg);border-color:transparent}.next p{margin:4px 0}.next textarea{background:var(--card)}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:22px 0 16px;overflow-x:auto}.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--muted);padding:8px 12px}.tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
.summary-line{display:flex;flex-wrap:wrap;gap:12px 28px;margin:0 0 12px}.summary-line .big{font-size:22px;font-weight:700;margin-right:4px}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:12px 0}.chip{padding:4px 10px;border-radius:999px;font-size:13px}.chip[aria-pressed=false]{opacity:.45}
.findings{display:grid;gap:10px}.finding{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:12px 14px}.finding.dim{opacity:.6}.finding h3{margin:0;font-size:15px}.finding header{display:flex;gap:10px;align-items:baseline}.finding p{margin:6px 0}.finding .loc{font-size:13px;color:var(--muted)}.finding footer{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;margin-top:6px;font-size:12.5px}
.finding[data-sev=P1]{border-left-color:var(--p1)}.finding[data-sev=P2]{border-left-color:var(--p2)}.finding[data-sev=P3]{border-left-color:var(--p3)}.finding[data-sev=P4]{border-left-color:var(--p4)}
.sev{flex:none;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}.sev.p1{color:var(--p1)}.sev.p2{color:var(--p2)}.sev.p3{color:var(--p3)}.sev.p4{color:var(--p4)}.chip.p1{color:var(--p1)}.chip.p2{color:var(--p2)}.chip.p3{color:var(--p3)}.chip.p4{color:var(--p4)}
.ev{font-weight:600;color:var(--muted)}.ev.ok{color:var(--ok)}.ev.warn{color:var(--warn)}.ev.bad{color:var(--bad)}
.pbar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:6px 0}.pbar span{display:block;height:100%;background:var(--accent);transition:width .4s}
ol.steps{list-style:none;margin:10px 0 0;padding:0}ol.steps li{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}ol.steps li>span:nth-child(2){flex:1}ol.steps li.pending{color:var(--muted)}ol.steps li.done .dot{border-color:var(--ok);background:var(--ok-bg)}ol.steps li.running .dot{border-color:var(--run);color:var(--run)}ol.steps li.failed .dot{border-color:var(--bad);color:var(--bad)}ol.steps li.waiting .dot{border-color:var(--warn);color:var(--warn)}
.artifact{max-height:640px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px 16px;background:var(--card)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:16px 0 4px}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.tile .big{font-size:20px;font-weight:600;margin:2px 0}
table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.barcell{width:30%;min-width:80px}.bar{height:8px;background:var(--bg);border-radius:4px;overflow:hidden}.bar span{display:block;height:100%;background:var(--accent)}.bar.tok span{background:var(--warn)}
.pill{display:inline-block;padding:0 8px;border-radius:999px;border:1px solid var(--line);font-size:12px}.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}
.trace td{font-size:12.5px}.hide-mc tr.mc{display:none}dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0}
.subnav{display:flex;gap:4px;margin:0 0 16px;border-bottom:1px solid var(--line)}.subnav a{padding:8px 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}.subnav a[aria-current]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
ol.howto{margin:0 0 8px;padding-left:20px}
@media (max-width:640px){.runhead{flex-direction:column}.trace td:first-child{display:none}table.list td{display:block;border:0;padding:4px 12px}table.list tr{display:block;border-bottom:1px solid var(--line);padding:6px 0}table.list thead{display:none}.num{text-align:left}}
`;
