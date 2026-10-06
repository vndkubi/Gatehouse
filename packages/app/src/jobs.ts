import { canRunWorkflow, type RepoRecord } from '@gatehouse/core';
import { AwaitingGate, GateRejected } from '@gatehouse/gates';
import { parseGitHubRemote } from '@gatehouse/github';
import { detectFacts, renderSpec, synthesize, verifyEnv, type EnvLevel, type EnvSpec, type VerifyReport } from '@gatehouse/env';
import { fetchMirror, resolveCommit, scrubEnv, takeFingerprint } from '@gatehouse/targets';
import { StageBlocked, latestEnv, runPrReview, type PrReviewResult, type ReviewSource } from '@gatehouse/workflows';
import { StepFailed } from '@gatehouse/engine';
import { CellTarget } from './cell-target.ts';
import { McpProxy } from '@gatehouse/mcp-proxy';
import { adapters, envApprovedFor, githubClient, routesFor, runIdFor, startGateway, targetFor, type Runtime } from './runtime.ts';

export type Log = (line: string) => void;

export interface JobOutcome<T = unknown> {
  runId: string;
  status: 'done' | 'awaiting-gate' | 'blocked' | 'rejected' | 'denied' | 'failed';
  message: string;
  result?: T;
}

export function mustRepo(rt: Runtime, name: string): RepoRecord {
  const repo = rt.repos.get(name);
  if (!repo) throw new Error(`unknown repo ${name}; register it with: gatehouse repo add <url>`);
  return repo;
}

// ---- environment onboarding (A1 / B1) ---------------------------------------------------------

export interface OnboardOptions {
  repo: string;
  ref?: string;
  maxLevel?: EnvLevel;
  fetch?: boolean;
  keep?: boolean;
  target?: 'host' | 'cell';
}

export interface OnboardResult {
  spec: EnvSpec;
  report: VerifyReport;
  specHash: string;
  reportHash: string;
  facts: number;
}

/** Detect → synthesize → (warm, for cells) → verify; ends at GATE_ENV. */
export async function onboardJob(rt: Runtime, o: OnboardOptions, log: Log, runId = runIdFor('onboard', o.repo)): Promise<JobOutcome<OnboardResult>> {
  const repo = mustRepo(rt, o.repo);
  if (o.fetch !== false) await fetchMirror(repo.mirror).catch((e: Error) => log(`warning: fetch failed, using mirror as-is (${e.message})`));
  const ref = o.ref ?? repo.defaultBranch;
  const sha = await resolveCommit(repo.mirror, ref);
  const kind = o.target ?? rt.config.runtime.target;
  const maxLevel = o.maxLevel ?? 'L2';
  rt.events.append(runId, 'RUN_STARTED', { workflow: 'env-onboarding', repo: o.repo, ref, sha, target: kind, maxLevel });

  // Detect on a plain host checkout first (reading files only), then build the target workspace with the spec.
  const probe = await rt.host.prepare({ runId, repo: o.repo, sha, slot: 'detect' });
  const facts = detectFacts(probe.dir);
  await rt.host.destroy(probe);
  const fingerprint = kind === 'host' ? await takeFingerprint(scrubEnv(process.env).env) : undefined;
  const spec = synthesize({ repo: o.repo, derivedFrom: { ref, sha }, target: kind, facts, fingerprint });
  const factsArt = rt.artifacts.putJson('env.facts', facts, { runId, sha });
  const fpArt = fingerprint ? rt.artifacts.putJson('host.fingerprint', fingerprint, { runId }) : null;
  const specArt = rt.artifacts.put('env.spec', renderSpec(spec), 'application/yaml', { runId, sha, inputs: [factsArt.hash, ...(fpArt ? [fpArt.hash] : [])] });
  rt.events.append(runId, 'ENV_DETECTED', { facts: factsArt.hash, fingerprint: fpArt?.hash ?? null, spec: specArt.hash, stack: spec.stack, target: kind });
  log(`Detected ${spec.stack} (${facts.length} facts); spec ${specArt.hash.slice(0, 12)}`);

  const target = targetFor(rt, kind);
  if (target instanceof CellTarget) {
    const avail = await target.available();
    if (!avail.ok) throw new Error(`cell runtime unavailable: ${avail.reason}`);
  }
  const ws = await target.prepare({ runId, repo: o.repo, sha, env: spec });
  rt.events.append(runId, 'WORKSPACE_PREPARED', { dir: ws.dir, sha, target: kind });
  try {
    const warmCmd = spec.commands.coverage ?? spec.commands.testAll;
    if (target instanceof CellTarget && warmCmd) {
      log('Warming the dependency cache (network on, trusted base-branch build)...');
      const w = await target.warm(ws, warmCmd.argv, rt.config.review.stepTimeoutMinutes * 60_000 * 2);
      const why = w.code === 0 ? [] : `${w.stdout}\n${w.stderr}`.split('\n').filter((l) => /ERROR|error:|Exception|denied|not found/i.test(l) && !/\[Help 1\]|re-run Maven|full stack trace|^\[ERROR\]\s*$/.test(l)).slice(0, 5);
      rt.events.append(runId, 'CELL_WARMED', { code: w.code, durationMs: w.durationMs, errors: why.map((l) => l.slice(0, 300)) });
      log(`  warm ${(w.durationMs / 1000).toFixed(1)}s (exit ${w.code})`);
      for (const l of why) log(`    ${l.trim().slice(0, 240)}`);
    }
    const report = await verifyEnv(target, ws, spec, {
      maxLevel,
      onStep: (s) => {
        log(`  ${s.code === 0 && !s.timedOut ? 'ok  ' : 'FAIL'} ${s.name.padEnd(12)} ${(s.durationMs / 1000).toFixed(1).padStart(7)}s  ${s.argv.join(' ')}`);
        rt.events.append(runId, 'VERIFY_STEP', { name: s.name, argv: s.argv, code: s.code, durationMs: s.durationMs, timedOut: s.timedOut });
      },
    });
    const reportArt = rt.artifacts.putJson('env.verify', report, { runId, spec: specArt.hash });
    rt.events.append(runId, 'ENV_VERIFIED', { level: report.level, spec: specArt.hash, report: reportArt.hash, target: kind });
    rt.events.append(runId, 'AWAITING_GATE', { gate: 'GATE_ENV', artifact: specArt.hash });
    return {
      runId,
      status: 'awaiting-gate',
      message: `Reached ${report.level}; approve the environment (GATE_ENV) in the console.`,
      result: { spec, report, specHash: specArt.hash, reportHash: reportArt.hash, facts: facts.length },
    };
  } finally {
    if (!o.keep) await target.destroy(ws);
  }
}

// ---- PR / branch review (A5 + parity) ---------------------------------------------------------

export interface ReviewOptions {
  repo: string;
  pr?: number;
  github?: string;
  base?: string;
  head?: string;
  title?: string;
  body?: string;
  critic?: boolean;
  keep?: boolean;
  /** Token budget for this run; defaults to llm.budgetTokensPerRun. */
  budgetTokens?: number;
}

export interface ReviewStart {
  workflow: 'pr-review';
  repo: string;
  source: ReviewSource;
  critic: boolean;
  budgetTokens?: number;
}

export function reviewStart(rt: Runtime, o: ReviewOptions): ReviewStart {
  const repo = mustRepo(rt, o.repo);
  let source: ReviewSource;
  if (o.pr) {
    const gh = o.github ? parseGitHubRemote(`github.com/${o.github}`) : parseGitHubRemote(repo.source);
    if (!gh) throw new Error('cannot tell the GitHub owner/name from the repo source; pass --github owner/name');
    source = { kind: 'pr', owner: gh.owner, repoName: gh.repo, number: o.pr };
  } else {
    if (!o.head) throw new Error('give --pr N, or --head <ref> (and optionally --base <ref>) for a branch review');
    source = { kind: 'refs', base: o.base ?? repo.defaultBranch, head: o.head, title: o.title ?? `Branch review ${o.head}`, body: o.body ?? '', label: `${o.repo}: ${o.base ?? repo.defaultBranch}...${o.head}` };
  }
  if (o.budgetTokens !== undefined && (!Number.isInteger(o.budgetTokens) || o.budgetTokens < 10_000)) throw new Error('budget must be a whole number of tokens, at least 10000');
  return { workflow: 'pr-review', repo: o.repo, source, critic: o.critic !== false, ...(o.budgetTokens ? { budgetTokens: o.budgetTokens } : {}) };
}

export async function reviewJob(rt: Runtime, start: ReviewStart, log: Log, runId?: string, keep = false): Promise<JobOutcome<PrReviewResult>> {
  // A caller may pick the id up front (the console links to the run before it starts); it is a resume only if the run exists.
  const resuming = !!runId && rt.events.list(runId).some((e) => e.type === 'RUN_STARTED');
  const id = runId ?? runIdFor('prr', start.repo, start.source.kind === 'pr' ? start.source.number : 'branch');
  const repo = mustRepo(rt, start.repo);
  const decision = canRunWorkflow({ workflow: 'pr-review', repo: repo.name, pciScope: repo.pciScope, routes: routesFor(rt, start.critic) });
  if (!decision.allow) {
    rt.events.append(id, 'POLICY_DENIED', { reasons: decision.reasons });
    return { runId: id, status: 'denied', message: decision.reasons.join('\n') };
  }
  rt.events.append(id, resuming ? 'RUN_RESUMED' : 'RUN_STARTED', resuming ? {} : start);
  const github = start.source.kind === 'pr' ? await githubClient(rt) : null;
  const { gateway, url } = await startGateway(rt);
  // A later BUDGET_SET (run retry/resume --budget-tokens) overrides the budget the run started with.
  const raised = rt.events.list(id).filter((e) => e.type === 'BUDGET_SET').at(-1)?.payload as { tokens?: number } | undefined;
  const budget = raised?.tokens ?? start.budgetTokens ?? rt.config.llm.budgetTokensPerRun;
  gateway.setBudget(id, budget);
  const { copilot, codex } = adapters(rt, url);
  const tickets = await ticketFetcher(rt, id);
  try {
    if (!copilot) throw new Error('Copilot executor is disabled; the reviewer needs it');
    const result = await runPrReview(
      {
        config: rt.config,
        events: rt.events,
        artifacts: rt.artifacts,
        repo,
        target: repoTarget(rt, repo.name),
        runsDir: rt.paths.runs,
        github,
        reviewer: copilot,
        critic: start.critic ? codex : null,
        usage: () => gateway.usageFor(id),
        budgetTokens: budget,
        fetchTicket: tickets?.fetch,
        envApproved: envApprovedFor(rt),
        log,
      },
      { runId: id, source: start.source, keepWorkspaces: keep },
    );
    rt.events.append(id, 'RUN_USAGE', gateway.usageFor(id));
    const pr = start.source.kind === 'pr';
    if (!pr) rt.events.append(id, 'RUN_COMPLETED', { packageHash: result.packageHash });
    return {
      runId: id,
      status: pr ? 'awaiting-gate' : 'done',
      message: `${result.postable} finding(s) to post (${result.findings} total).${pr ? ' Awaiting GATE_5.' : ''}`,
      result,
    };
  } catch (err) {
    rt.events.append(id, 'RUN_USAGE', gateway.usageFor(id));
    return { runId: id, status: 'failed', message: (err as Error).message };
  } finally {
    await tickets?.close();
    await gateway.stop();
  }
}

// ---- MCP ticket lookup --------------------------------------------------------------------------

export function mcpProxy(rt: Runtime): McpProxy {
  return new McpProxy({
    servers: rt.config.mcp.servers,
    events: rt.events,
    signer: rt.signer,
    resolveSecret: (name) => rt.secrets.require(name),
    dlp: { testPanAllowlist: rt.config.pci.testPanAllowlist },
  });
}

/** Intake hook for `review.ticketTool` ("server:tool:argName"); Gatehouse itself is the MCP client. */
export async function ticketFetcher(rt: Runtime, runId: string): Promise<{ fetch: (key: string) => Promise<string | null>; close: () => Promise<void> } | null> {
  const spec = rt.config.review.ticketTool;
  if (!spec) return null;
  const [server, tool, arg] = spec.split(':') as [string, string, string];
  if (!rt.config.mcp.servers[server]) throw new Error(`review.ticketTool points at unknown MCP server ${server}`);
  const proxy = mcpProxy(rt);
  return {
    fetch: async (key) => {
      try {
        return await proxy.callTool({ runId, stepId: 'intake', server, tool, args: { [arg]: key } });
      } catch (err) {
        rt.events.append(runId, 'TICKET_UNAVAILABLE', { key, error: (err as Error).message.slice(0, 200) });
        return null;
      }
    },
    close: () => proxy.close(),
  };
}

// ---- resume dispatch ----------------------------------------------------------------------------

/** Continues any interrupted or gate-approved run from where it stopped. */
export async function resumeJob(rt: Runtime, runId: string, log: Log): Promise<JobOutcome> {
  const started = rt.events.list(runId).find((e) => e.type === 'RUN_STARTED');
  if (!started) throw new Error(`no run ${runId}`);
  const p = started.payload as { workflow: string };
  try {
    switch (p.workflow) {
      case 'pr-review':
        return await reviewJob(rt, started.payload as ReviewStart, log, runId);
      case 'ticket':
        return await (await import('./ticket-job.ts')).ticketJob(rt, started.payload as never, log, runId);
      case 'legacy-tests':
        return await (await import('./legacy-job.ts')).legacyJob(rt, started.payload as never, log, runId);
      default:
        throw new Error(`run ${runId} (${p.workflow}) cannot be resumed`);
    }
  } catch (err) {
    return gateOutcome(runId, err);
  }
}

/** Maps gate exceptions from multi-gate pipelines to outcomes; anything else is a failure. */
export function gateOutcome(runId: string, err: unknown): JobOutcome {
  if (err instanceof AwaitingGate) return { runId, status: 'awaiting-gate', message: err.message };
  if (err instanceof StageBlocked) return { runId, status: 'blocked', message: err.message };
  if (err instanceof StepFailed && err.cause instanceof StageBlocked) return { runId, status: 'blocked', message: err.cause.message };
  if (err instanceof GateRejected) return { runId, status: 'rejected', message: err.message };
  return { runId, status: 'failed', message: (err as Error).message };
}

/** Latest environment for a repo plus whether a human approved it at GATE_ENV, and its test baseline. */
export async function envFor(rt: Runtime, repo: string) {
  const env = latestEnv(rt.events, rt.artifacts, repo);
  const approved = env.onboardRun && env.specHash ? await envApprovedFor(rt)(env.onboardRun, env.specHash) : false;
  let baseline: VerifyReport['baseline'] | null = null;
  if (env.onboardRun) {
    const verified = rt.events.list(env.onboardRun).filter((e) => e.type === 'ENV_VERIFIED').at(-1)?.payload as { report?: string } | undefined;
    if (verified?.report) baseline = (JSON.parse(rt.artifacts.read(verified.report).toString('utf8')) as VerifyReport).baseline ?? null;
  }
  return { level: env.level, spec: env.spec, approved, baseline, target: verifiedTarget(rt, repo) };
}

/**
 * The target a repo's approved environment was verified on. Workflows run tests there, so a repo
 * onboarded with `--target cell` keeps every later build/test inside sandbox cells.
 */
export function verifiedTarget(rt: Runtime, repo: string): 'host' | 'cell' {
  const env = latestEnv(rt.events, rt.artifacts, repo);
  if (!env.onboardRun) return rt.config.runtime.target;
  const verified = rt.events.list(env.onboardRun).filter((e) => e.type === 'ENV_VERIFIED').at(-1)?.payload as { target?: 'host' | 'cell' } | undefined;
  return verified?.target ?? 'host';
}

export function repoTarget(rt: Runtime, repo: string) {
  return targetFor(rt, verifiedTarget(rt, repo));
}
