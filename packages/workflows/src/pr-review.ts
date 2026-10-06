import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type ArtifactStore, type EventStore, type GatehouseConfig, type RepoRecord } from '@gatehouse/core';
import { redact } from '@gatehouse/dlp';
import { StepRunner, mapLimit } from '@gatehouse/engine';
import type { EnvSpec } from '@gatehouse/env';
import type { GitHubClient } from '@gatehouse/github';
import type { AgentResult, ExecutorAdapter } from '@gatehouse/harness';
import { fetchMirror, fetchPullRequest, git, maskAgentInstructions, resolveCommit, type ExecutionTarget, type Workspace } from '@gatehouse/targets';
import { blastRadius, type BlastRadius } from './blast.ts';
import { numberedHunk, parseUnifiedDiff, type FileDiff, type Hunk } from './diff.ts';
import { runJavaRepro } from './evidence.ts';
import { applyChallenge, dedupe, postable, verifyCitation, type CriticVerdict, type Evidence, type Finding, type RawFinding, type Severity } from './findings.ts';
import type { AcStatus, ReviewPackage, Requirements } from './package.ts';
import { planReview, unreviewable, type ReviewUnit, type UnitKind } from './plan.ts';
import { fill, loadAgent, untrusted, type AgentSpec } from './registry.ts';
import { renderHtml, renderSummary } from './render.ts';
import { loadRiskRouting } from './routing.ts';
import { bindSteps, loadWorkflow, stepDef, stepParam } from './workflow-def.ts';

/** What to review: a GitHub pull request, or any two commits already in the mirror (branch / self review). */
export type ReviewSource =
  | { kind: 'pr'; owner: string; repoName: string; number: number }
  | { kind: 'refs'; base: string; head: string; title: string; body: string; label: string };

export interface PrReviewDeps {
  config: GatehouseConfig;
  events: EventStore;
  artifacts: ArtifactStore;
  repo: RepoRecord;
  target: ExecutionTarget;
  runsDir: string;
  github: GitHubClient | null;
  /** Gateway-routed reviewer (Copilot). */
  reviewer: ExecutorAdapter;
  /** Independent critic on a different model (Codex), or null to skip the challenge. */
  critic: ExecutorAdapter | null;
  usage: () => ReviewPackage['usage'];
  /** Token budget of this run; units are not started once it is spent. */
  budgetTokens?: number;
  /** Optional ticket lookup through the MCP proxy. Returns already-DLP'd text. */
  fetchTicket?: (key: string) => Promise<string | null>;
  /** Whether the repo's environment spec was approved at GATE_ENV (signature-verified). */
  envApproved?: (onboardRunId: string, specHash: string) => Promise<boolean>;
  log?: (line: string) => void;
}

export interface PrReviewInput {
  runId: string;
  source: ReviewSource;
  keepWorkspaces?: boolean;
  /** Part of another pipeline (ticket code review): finishes without its own GATE_5. */
  embedded?: boolean;
}

export interface PrReviewResult {
  packageHash: string;
  summaryPath: string;
  htmlPath: string;
  findings: number;
  postable: number;
}

interface Context {
  title: string;
  body: string;
  author: string;
  url: string;
  base: string;
  head: string;
  mergeBase: string;
}

interface UnitResult {
  unit: string;
  kind: UnitKind;
  ok: boolean;
  reviewed: string[];
  findings: RawFinding[];
  acStatus?: AcStatus[];
  /** Why the unit did not complete, when known. */
  reason?: string;
}

/** Below this per-unit budget a review of a large diff is likely to run out (agentic loops re-send context). */
const UNIT_TOKENS_WARN = 600_000;

/** H3, H4, H5, H9 → "H3–H5, H9". */
function compactIds(ids: string[]): string {
  const nums = ids.map((h) => Number(h.slice(1))).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    parts.push(j > i ? `H${nums[i]}–H${nums[j]}` : `H${nums[i]}`);
    i = j;
  }
  return parts.join(', ');
}

const REPRO_ON =
  'Only for P1/P2 findings that a unit test can demonstrate, set `repro` to {"test_class": fully qualified name in the same package as the code under test with a simple name ending in GatehouseReproTest, "test_source": the complete Java file}. The test must FAIL on the current code because of the defect and PASS once it is fixed, and may only use test libraries this repository already uses. Otherwise set `repro` to null.';
const REPRO_OFF = 'Set `repro` to null for every finding (this repository has no approved, verified test environment).';

/**
 * PR review workflow (design 03 §3.2; step order in registry/workflows/pr-review.yaml).
 * Deterministic code everywhere except quarantine-read, review and challenge. Agent output is
 * schema-validated, citations are checked against the files, evidence comes from running tests,
 * verdicts are computed by code, and the run ends at GATE_5 — nothing is posted from here.
 */
export async function runPrReview(deps: PrReviewDeps, input: PrReviewInput): Promise<PrReviewResult> {
  const def = loadWorkflow('pr-review');
  const log = deps.log ?? (() => undefined);
  const runner = new StepRunner(deps.events, input.runId, log);
  const runDir = join(deps.runsDir, input.runId);
  const dlp = { testPanAllowlist: deps.config.pci.testPanAllowlist };
  const timeoutMs = deps.config.review.stepTimeoutMinutes * 60_000;
  const json = <T>(hash: string) => JSON.parse(deps.artifacts.read(hash).toString('utf8')) as T;
  const src = input.source;

  const env = latestEnv(deps.events, deps.artifacts, deps.repo.name);
  const envApproved = env.onboardRun && env.specHash && deps.envApproved ? await deps.envApproved(env.onboardRun, env.specHash) : false;
  const reproAllowed = env.level === 'L2' && env.spec?.stack === 'java-maven' && envApproved;

  // State filled in by the steps (from their stored results on resume).
  let ctx!: Context;
  let files: FileDiff[] = [];
  let hunks = new Map<string, Hunk>();
  let ws!: Workspace;
  let masked: string[] = [];
  let blast: BlastRadius = { symbols: [], testsAtRisk: [], dependentFiles: [] };
  let intakeHash = '';
  let requirements: Requirements | null = null;
  let units: ReviewUnit[] = [];
  let reviewed: UnitResult[] = [];
  let findings: Finding[] = [];
  let result!: PrReviewResult;

  const agentFor = (step: string): AgentSpec => loadAgent(stepDef(def, step).agent!);

  const steps = bindSteps<() => Promise<void>>(def, {
    // Pin the exact commits once; everything after works on these SHAs.
    freeze: async () => {
      ctx = await runner.step('freeze', async (): Promise<Context> => {
        await fetchMirror(deps.repo.mirror);
        if (src.kind === 'refs') {
          const base = await resolveCommit(deps.repo.mirror, src.base);
          const head = await resolveCommit(deps.repo.mirror, src.head);
          const mergeBase = await git(['-C', deps.repo.mirror, 'merge-base', base, head]);
          return { title: src.title, body: src.body, author: '', url: '', base, head, mergeBase };
        }
        if (!deps.github) throw new Error('a GitHub client is required to review a pull request');
        const pr = await deps.github.getPull(src.owner, src.repoName, src.number);
        const head = await fetchPullRequest(deps.repo.mirror, src.number);
        if (pr.head.sha && pr.head.sha !== head) throw new Error(`PR head moved while freezing (${pr.head.sha} vs ${head}); retry`);
        const mergeBase = await git(['-C', deps.repo.mirror, 'merge-base', pr.base.sha, head]);
        return { title: pr.title, body: pr.body, author: pr.author, url: pr.url, base: pr.base.sha, head, mergeBase };
      });
    },

    enumerate: async () => {
      const hash = await runner.step('enumerate', async () => {
        const diff = await git(['-C', deps.repo.mirror, 'diff', '--no-color', '--no-ext-diff', '-U3', ctx.mergeBase, ctx.head]);
        return deps.artifacts.putJson('pr.diff', parseUnifiedDiff(diff), { runId: input.runId, base: ctx.mergeBase, head: ctx.head }).hash;
      });
      files = json<FileDiff[]>(hash);
      hunks = new Map(files.flatMap((f) => f.hunks).map((h) => [h.id, h] as const));
    },

    // Workspace at head with agent-instruction files masked out.
    mask: async () => {
      ws = await deps.target.prepare({ runId: input.runId, repo: deps.repo.name, sha: ctx.head, slot: 'work', reuse: true });
      masked = await runner.step('mask', async () => maskAgentInstructions(ws.dir, join(runDir, 'masked')));
    },

    'blast-radius': async () => {
      const hash = await runner.step('blast-radius', async () => {
        const b = await blastRadius(ws.dir, files, stepParam(def, 'blast-radius', 'maxSymbols', 15), stepParam(def, 'blast-radius', 'maxUsagesPerSymbol', 20));
        return deps.artifacts.putJson('pr.blast', b, { runId: input.runId }).hash;
      });
      blast = json<BlastRadius>(hash);
    },

    // PR text (+ tickets via MCP), DLP'd and marked untrusted.
    intake: async () => {
      intakeHash = await runner.step('intake', async () => {
        const parts = [untrusted('pr-title', redact(ctx.title, dlp).text), untrusted('pr-body', redact(ctx.body || '(empty)', dlp).text)];
        const keys = [...new Set(`${ctx.title}\n${ctx.body}`.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])].slice(0, 5);
        for (const key of keys) {
          const ticket = deps.fetchTicket ? await deps.fetchTicket(key) : null;
          if (ticket) parts.push(untrusted(`ticket:${key}`, ticket));
        }
        return deps.artifacts.put('pr.intake', parts.join('\n\n'), 'text/markdown', { runId: input.runId, tickets: keys }).hash;
      });
    },

    // An agent with no repo access turns untrusted text into requirements.
    'quarantine-read': async () => {
      const d = stepDef(def, 'quarantine-read');
      const spec = agentFor('quarantine-read');
      requirements = await runner.step('quarantine-read', async (): Promise<Requirements | null> => {
        const scratch = join(runDir, 'scratch', 'quarantine-read');
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, 'input.md'), deps.artifacts.read(intakeHash).toString('utf8'));
        const r = await deps.reviewer.run({
          runId: input.runId,
          stepId: 'quarantine-read',
          instructions: spec.prompt,
          outputSchema: spec.schema,
          scope: 'none',
          cwd: scratch,
          stateDir: join(runDir, 'agents', 'quarantine-read'),
          tier: d.tier ?? 'tier-scale',
          timeoutMs,
        });
        agentEvent(runner, 'quarantine-read', deps.reviewer.id, spec.version, r);
        return r.ok ? (r.output as Requirements) : null;
      });
    },

    plan: async () => {
      units = await runner.step('plan', async () =>
        planReview({
          files,
          requirements,
          viewpoints: loadRiskRouting(stepParam(def, 'plan', 'routing', 'risk-routing')),
          blast,
          maxLines: deps.config.review.maxUnitLines,
          maxSeamUnits: stepParam(def, 'plan', 'maxSeamUnits', 3),
          maxAcPerUnit: stepParam(def, 'plan', 'maxAcPerBusinessUnit', 8),
        }),
      );
      if (deps.budgetTokens) {
        const perUnit = Math.floor(deps.budgetTokens / Math.max(1, units.length));
        log(`  plan: ${units.length} unit(s), budget ${deps.budgetTokens.toLocaleString('en-US')} tokens (~${perUnit.toLocaleString('en-US')} per unit)`);
        if (perUnit < UNIT_TOKENS_WARN) {
          runner.emit('BUDGET_WARNING', { units: units.length, budget: deps.budgetTokens, perUnit });
          log(`  warning: agentic review typically needs ~${UNIT_TOKENS_WARN.toLocaleString('en-US')}+ tokens per unit; units after the budget is spent will be incomplete (raise with --budget-tokens)`);
        }
      }
    },

    review: async () => {
      const hash = await runner.step('review', async () => {
        // A retry keeps units that already completed on exactly the same hunks (budget runs out,
        // a worker crashes): re-reviewing them would only spend tokens again.
        const previous = deps.events.list(input.runId).filter((e) => e.type === 'STEP_DONE' && (e.payload as { stepId?: string }).stepId === 'review').at(-1);
        const reusable = new Map<string, UnitResult>();
        if (previous) {
          for (const r of json<UnitResult[]>(String((previous.payload as { result: string }).result))) {
            const unit = units.find((u) => u.id === r.unit);
            if (r.ok && unit && unit.hunkIds.join(',') === r.reviewed.join(',')) reusable.set(r.unit, r);
          }
          if (reusable.size) {
            runner.emit('UNITS_REUSED', { units: [...reusable.keys()] });
            log(`  review: reusing ${reusable.size} completed unit(s) from the previous attempt (${[...reusable.keys()].join(', ')})`);
          }
        }
        const results = await mapLimit(units, deps.config.review.maxWorkers, async (unit) => reusable.get(unit.id) ?? reviewUnit(unit));
        return deps.artifacts.putJson('pr.review.raw', results, { runId: input.runId }).hash;
      });
      reviewed = json<UnitResult[]>(hash);
    },

    // Verify every file:line + quote against the head checkout.
    citations: async () => {
      const hash = await runner.step('citations', async () => {
        let n = 0;
        const commentable = new Map<string, Set<number>>();
        for (const f of files) commentable.set(f.file, new Set(f.hunks.flatMap((h) => h.commentable)));
        const out: Finding[] = reviewed.flatMap((u) =>
          u.findings.map((raw): Finding => {
            const check = verifyCitation(ws.dir, raw.file, raw.line, raw.evidence_quote);
            return {
              ...raw,
              id: `F${++n}`,
              unit: u.unit,
              evidence: check.ok ? 'CITED' : 'NO_EVIDENCE',
              verdict: check.ok ? 'UNCHALLENGED' : 'REJECTED',
              inDiff: commentable.get(raw.file)?.has(raw.line) ?? false,
              notes: check.ok ? [] : [`Citation rejected: ${check.reason}`],
            };
          }),
        );
        return deps.artifacts.putJson('pr.findings.cited', out, { runId: input.runId }).hash;
      });
      findings = json<Finding[]>(hash);
    },

    // Repro tests on head, then merge base, when the repo has an approved L2 environment.
    evidence: async () => {
      const severities = stepParam<Severity[]>(def, 'evidence', 'severities', ['P1', 'P2']);
      const hash = await runner.step('evidence', async () => {
        if (!reproAllowed || !env.spec) return deps.artifacts.putJson('pr.findings.evidence', findings, { runId: input.runId, skipped: true }).hash;
        let headWs: Workspace | null = null;
        let baseWs: Workspace | null = null;
        const out: Finding[] = [];
        for (const f of findings) {
          if (f.evidence !== 'CITED' || !f.repro || !severities.includes(f.severity)) {
            out.push(f);
            continue;
          }
          headWs ??= await deps.target.prepare({ runId: input.runId, repo: deps.repo.name, sha: ctx.head, slot: 'evidence', reuse: true });
          const onHead = await runJavaRepro(deps.target, headWs, env.spec, f.file, f.repro.test_class, f.repro.test_source, timeoutMs);
          let evidence: Evidence = onHead.outcome === 'RED' ? 'REPRO_RED' : onHead.outcome === 'GREEN' ? 'REPRO_GREEN' : 'REPRO_INCONCLUSIVE';
          const notes = [...f.notes, `Repro on PR head: ${onHead.outcome} (${onHead.reason}).`];
          if (onHead.outcome === 'RED') {
            baseWs ??= await deps.target.prepare({ runId: input.runId, repo: deps.repo.name, sha: ctx.mergeBase, slot: 'evidence-base', reuse: true });
            const onBase = await runJavaRepro(deps.target, baseWs, env.spec, f.file, f.repro.test_class, f.repro.test_source, timeoutMs);
            notes.push(`Repro on merge base: ${onBase.outcome} (${onBase.reason}).`);
            if (onBase.outcome === 'RED') evidence = 'REPRO_RED_BOTH';
          }
          runner.emit('REPRO_RUN', { finding: f.id, evidence, headMs: onHead.durationMs });
          out.push({ ...f, evidence, notes });
        }
        if (!input.keepWorkspaces) for (const w of [headWs, baseWs]) if (w) await deps.target.destroy(w);
        return deps.artifacts.putJson('pr.findings.evidence', out, { runId: input.runId }).hash;
      });
      findings = json<Finding[]>(hash);
    },

    // An independent critic on a different model; code decides the outcome.
    challenge: async () => {
      const severities = stepParam<Severity[]>(def, 'challenge', 'severities', ['P1', 'P2']);
      const spec = agentFor('challenge');
      const d = stepDef(def, 'challenge');
      const hash = await runner.step('challenge', async () => {
        const targets = findings.filter((f) => f.evidence !== 'NO_EVIDENCE' && severities.includes(f.severity));
        let verdicts = new Map<string, CriticVerdict>();
        if (deps.critic && targets.length) {
          const r = await deps.critic.run({
            runId: input.runId,
            stepId: 'challenge',
            instructions: fill(spec.prompt, {
              requirements: requirementsText(requirements),
              findings: targets
                .map((f) => untrusted(`finding:${f.id}`, `id: ${f.id}\n[${f.severity}] ${f.title}\nat ${f.file}:${f.line}\nquote: ${f.evidence_quote}\n${f.explanation}\nScenario: ${f.failing_scenario}`))
                .join('\n\n'),
            }),
            outputSchema: spec.schema,
            scope: 'read-repo',
            cwd: ws.dir,
            stateDir: join(runDir, 'agents', 'challenge'),
            tier: d.tier ?? 'tier-frontier',
            timeoutMs,
          });
          agentEvent(runner, 'challenge', deps.critic.id, spec.version, r);
          if (r.ok) verdicts = new Map((r.output as { verdicts: CriticVerdict[] }).verdicts.map((v) => [v.finding_id, v]));
        }
        const out = findings.map((f) => {
          const v = targets.includes(f) ? verdicts.get(f.id) : undefined;
          const counterOk = !!v?.counter_evidence && verifyCitation(ws.dir, v.counter_evidence.file, v.counter_evidence.line, v.counter_evidence.quote).ok;
          return applyChallenge(f, v, counterOk);
        });
        return deps.artifacts.putJson('pr.findings.challenged', out, { runId: input.runId, critic: deps.critic?.id ?? 'none' }).hash;
      });
      findings = json<Finding[]>(hash);
    },

    synthesis: async () => {
      result = await runner.step('synthesis', async () => {
        const final = dedupe(findings);
        const tUnits = units.filter((u) => u.kind === 'T');
        const reviewedSet = new Set(reviewed.filter((r) => r.kind === 'T').flatMap((u) => u.reviewed));
        const ledgerHunks = tUnits.flatMap((u) => u.hunkIds);
        const acStatus = reviewed.flatMap((r) => r.acStatus ?? []);
        const claimed = new Set(acStatus.flatMap((a) => a.evidence_hunks));
        const orphans = requirements && acStatus.length ? ledgerHunks.filter((h) => !claimed.has(h)) : [];
        const failed = reviewed.filter((r) => !r.ok);
        const incompleteReasons = [
          ...failed.filter((r) => r.kind === 'T').map((r) => `technical unit ${r.unit} did not complete${r.reason ? ` (${r.reason})` : ''}`),
          ...failed.filter((r) => r.kind === 'V' && units.find((u) => u.id === r.unit)?.mandatory).map((r) => `mandatory viewpoint ${r.unit.slice(2)} did not complete${r.reason ? ` (${r.reason})` : ''}`),
        ];
        const unreviewed = ledgerHunks.filter((h) => !reviewedSet.has(h));
        if (unreviewed.length) incompleteReasons.push(`${unreviewed.length} of ${ledgerHunks.length} hunks were not reviewed (${compactIds(unreviewed)})`);
        const pkg: ReviewPackage = {
          version: 1,
          runId: input.runId,
          repo: deps.repo.name,
          pr: src.kind === 'pr' ? { owner: src.owner, repo: src.repoName, number: src.number, url: ctx.url, title: ctx.title, author: ctx.author } : null,
          source: { kind: src.kind, label: src.kind === 'pr' ? `${src.owner}/${src.repoName}#${src.number}` : src.label },
          base: ctx.base,
          head: ctx.head,
          mergeBase: ctx.mergeBase,
          envLevel: env.level + (env.level === 'L2' && !envApproved ? ' (not approved at GATE_ENV)' : ''),
          requirements,
          units,
          ledger: {
            totalHunks: ledgerHunks.length,
            reviewedHunks: ledgerHunks.filter((h) => reviewedSet.has(h)).length,
            missing: ledgerHunks.filter((h) => !reviewedSet.has(h)),
            incompleteUnits: failed.map((r) => r.unit),
          },
          unreviewable: unreviewable(files),
          acStatus,
          orphans,
          blast: { symbols: blast.symbols.length, dependentFiles: blast.dependentFiles, testsAtRisk: blast.testsAtRisk },
          incomplete: incompleteReasons.length > 0,
          incompleteReasons,
          masked,
          findings: final,
          agents: Object.fromEntries(def.steps.filter((s) => s.agent).map((s) => [s.agent!, loadAgent(s.agent!).version])),
          usage: deps.usage(),
          critic: deps.critic ? 'codex' : 'none',
          warnings: [
            ...(requirements ? [] : ['Requirements could not be extracted; reviewers worked from the diff alone.']),
            ...(reproAllowed ? [] : [`No repro tests were run: environment is ${env.level}${env.level === 'L2' && !envApproved ? ' but not approved at GATE_ENV' : ''} (findings are inspected-only).`]),
            ...(deps.critic ? [] : ['No independent critic ran; findings are unchallenged.']),
          ],
        };
        const art = deps.artifacts.putJson('pr.review.package', pkg, { runId: input.runId, head: ctx.head });
        const outDir = join(runDir, 'out');
        mkdirSync(outDir, { recursive: true });
        const summaryPath = join(outDir, 'SUMMARY.md');
        const htmlPath = join(outDir, 'review.html');
        writeFileSync(summaryPath, renderSummary(pkg));
        writeFileSync(htmlPath, renderHtml(pkg));
        writeFileSync(join(outDir, 'review-package.json'), JSON.stringify(pkg, null, 2));
        return { packageHash: art.hash, summaryPath, htmlPath, findings: final.length, postable: final.filter(postable).length };
      });
    },

    gate: async () => {
      await runner.step('gate', async () => {
        const gate = stepDef(def, 'gate').gate!;
        if (input.embedded) {
          runner.emit('REVIEW_COMPLETED', { artifact: result.packageHash });
          return { gate: null, artifact: result.packageHash };
        }
        runner.emit('AWAITING_GATE', { gate, artifact: result.packageHash });
        return { gate, artifact: result.packageHash };
      });
    },
  });

  for (const s of steps) await s.impl();
  if (!input.keepWorkspaces) await deps.target.destroy(ws);
  return result;

  async function reviewUnit(unit: ReviewUnit): Promise<UnitResult> {
    const d = stepDef(def, 'review');
    const agents = stepParam<Record<UnitKind, string>>(def, 'review', 'agents', { T: 'pr-reviewer', B: 'business-reviewer', V: 'viewpoint-reviewer', S: 'seam-reviewer' });
    const tiers = stepParam<Record<UnitKind, string>>(def, 'review', 'tiers', { T: 'tier-workhorse', B: 'tier-frontier', V: 'tier-workhorse', S: 'tier-workhorse' });
    const spec = loadAgent(agents[unit.kind]);
    const base = fill(spec.prompt, unitValues(unit));
    let instructions = base;
    const spent = () => {
      const u = deps.usage();
      return deps.budgetTokens !== undefined && u.promptTokens + u.completionTokens >= deps.budgetTokens;
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Fail fast: once the budget is gone every model call is refused, so don't start the agent.
      if (spent()) return { unit: unit.id, kind: unit.kind, ok: false, reviewed: [], findings: [], reason: 'token budget exhausted before it started' };
      const r = await deps.reviewer.run({
        runId: input.runId,
        stepId: `review-${unit.id}${attempt > 1 ? '-retry' : ''}`,
        instructions,
        outputSchema: spec.schema,
        scope: d.scope === 'none' ? 'none' : 'read-repo',
        cwd: ws.dir,
        stateDir: join(runDir, 'agents', `review-${unit.id}-${attempt}`),
        tier: tiers[unit.kind],
        timeoutMs,
      });
      agentEvent(runner, `review-${unit.id}`, deps.reviewer.id, spec.version, r);
      if (!r.ok && r.errors.some((e) => /budget/i.test(e))) return { unit: unit.id, kind: unit.kind, ok: false, reviewed: [], findings: [], reason: 'token budget exhausted' };
      if (!r.ok) continue;
      if (unit.kind === 'B') {
        const out = r.output as { ac_status: AcStatus[]; findings: RawFinding[] };
        const missingAc = (unit.acIds ?? []).filter((a) => !out.ac_status.some((s) => s.ac_id === a));
        if (!missingAc.length || attempt === 2) return { unit: unit.id, kind: 'B', ok: !missingAc.length, reviewed: [], findings: out.findings, acStatus: out.ac_status };
        instructions = `${base}\n\n## Correction\nYou did not report on ${missingAc.join(', ')}. Return a status for every assigned criterion.`;
        continue;
      }
      const out = r.output as { reviewed_hunks: string[]; findings: RawFinding[] };
      const missing = unit.hunkIds.filter((h) => !out.reviewed_hunks.includes(h));
      if (!missing.length) return { unit: unit.id, kind: unit.kind, ok: true, reviewed: unit.hunkIds, findings: out.findings };
      runner.emit('LEDGER_GAP', { unit: unit.id, missing, attempt });
      if (attempt === 2) return { unit: unit.id, kind: unit.kind, ok: false, reviewed: out.reviewed_hunks.filter((h) => unit.hunkIds.includes(h)), findings: out.findings };
      instructions = `${base}\n\n## Correction\nYour previous answer did not cover hunks ${missing.join(', ')}. Review every assigned hunk and return the complete result.`;
    }
    return { unit: unit.id, kind: unit.kind, ok: false, reviewed: [], findings: [] };
  }

  function unitValues(unit: ReviewUnit): Record<string, string> {
    const hunkText = (ids: string[], budget: number) => {
      let used = 0;
      const blocks: string[] = [];
      for (const id of ids) {
        const h = hunks.get(id)!;
        const block = hunkBlock(h);
        if (used > 0 && used + block.length > budget) {
          blocks.push(`(${ids.length - blocks.length} more hunk(s) not inlined: ${ids.slice(blocks.length).join(', ')} — read the files directly)`);
          break;
        }
        blocks.push(block);
        used += block.length;
      }
      return blocks.join('\n\n');
    };
    const common = { unitId: unit.id, requirements: requirementsText(requirements), reproRule: reproAllowed ? REPRO_ON : REPRO_OFF, hunkIds: unit.hunkIds.join(', '), riskTags: unit.riskTags.join(', ') || 'none' };
    if (unit.kind === 'B') {
      const acs = (requirements?.acceptance_criteria ?? []).filter((a) => unit.acIds?.includes(a.id));
      return { ...common, acceptance: untrusted('acceptance-criteria', acs.map((a) => `- ${a.id}: ${a.text}`).join('\n')), hunks: hunkText(unit.hunkIds, 60_000) };
    }
    if (unit.kind === 'V') {
      const v = loadRiskRouting().find((x) => x.id === unit.viewpoint)!;
      return { ...common, viewpointTitle: v.title, checklist: v.checklist.map((c) => `- ${c}`).join('\n'), hunks: hunkText(unit.hunkIds, 60_000) };
    }
    if (unit.kind === 'S') {
      const usages = (unit.usages ?? []).map((u) => `- ${u.file}:${u.line}${u.test ? ' (test)' : ''}: ${u.text}`).join('\n');
      return { ...common, hunks: hunkText(unit.hunkIds, 40_000), usages: untrusted('usages', usages) };
    }
    return { ...common, hunks: unit.hunkIds.map((id) => hunkBlock(hunks.get(id)!)).join('\n\n') };
  }
}

function hunkBlock(h: Hunk): string {
  return `### ${h.id} — ${h.file}\n${untrusted(`diff:${h.id}`, numberedHunk(h))}`;
}

function requirementsText(r: Requirements | null): string {
  if (!r) return '_Not available; infer intent from the diff._';
  const body = [r.summary, ...r.acceptance_criteria.map((a) => `- ${a.id}: ${a.text}`), ...(r.risks.length ? ['Risks:', ...r.risks.map((x) => `- ${x}`)] : [])].join('\n');
  return untrusted('requirements (derived from PR text)', body);
}

function agentEvent(runner: StepRunner, step: string, executor: string, agentVersion: string, r: AgentResult): void {
  runner.emit('AGENT_RUN', { step, executor, agentVersion, ok: r.ok, attempts: r.attempts, durationMs: r.durationMs, errors: r.errors.slice(0, 5) });
}

/** Latest verified environment for a repo (from `gatehouse env verify`), or L0. */
export function latestEnv(events: EventStore, artifacts: ArtifactStore, repo: string): { level: string; spec: EnvSpec | null; onboardRun: string | null; specHash: string | null } {
  const runs = events.runs().filter((r) => r.startsWith(`onboard-${repo}-`)).sort();
  for (const run of runs.reverse()) {
    const verified = events.list(run).filter((e) => e.type === 'ENV_VERIFIED').at(-1);
    if (!verified) continue;
    const { level, spec } = verified.payload as { level: string; spec: string };
    return { level, spec: parseYaml(artifacts.read(spec).toString('utf8')) as EnvSpec, onboardRun: run, specHash: spec };
  }
  return { level: 'L0', spec: null, onboardRun: null, specHash: null };
}
