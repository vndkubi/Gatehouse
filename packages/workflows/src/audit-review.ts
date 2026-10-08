import { mapLimit, type StepRunner } from '@gatehouse/engine';
import type { EnvSpec } from '@gatehouse/env';
import type { AgentResult, ResponseFormat, StructuredCaller, StructuredResult } from '@gatehouse/harness';
import type { Workspace } from '@gatehouse/targets';
import { join } from 'node:path';
import {
  ARM_LABEL,
  applyAnswer,
  buildAuditItems,
  classify,
  coverage,
  enclosingSymbol,
  groupByRootCause,
  itemCatalog,
  newOutcome,
  planBatches,
  readSpecRules,
  regionHunks,
  routeItems,
  specDirsFor,
  type AuditAnswer,
  type AuditBatch,
  type AuditItem,
  type Candidate,
  type CandidateGroup,
  type Citation,
  type ItemKind,
  type ItemOutcome,
  type ItemStatus,
  type Region,
  type ReviewArm,
  type RouteReason,
} from './audit.ts';
import type { BlastRadius } from './blast.ts';
import { buildContextPack, renderSnippets, resolveLookups, snippet, type Snippet } from './context-pack.ts';
import type { FileDiff, Hunk } from './diff.ts';
import { runJavaRepro, type ReproRun } from './evidence.ts';
import { verifyCitation, type Evidence, type Finding, type Verdict as FindingVerdict } from './findings.ts';
import type { Requirements } from './package.ts';
import type { ReviewUnit, UnitKind } from './plan.ts';
import type { PrReviewDeps, UnitResult } from './pr-review.ts';
import { loadAgent, untrusted } from './registry.ts';
import { loadRiskRouting } from './routing.ts';
import { stepDef, stepParam, type WorkflowDef } from './workflow-def.ts';

/** Outcome of verifying one root-cause group (design 09 §4). */
export type VerificationStatus = 'confirmed' | 'confirmed-preexisting' | 'unconfirmed' | 'withdrawn' | 'blocked' | 'explained' | 'not-verified';

export interface Verification {
  group: string;
  status: VerificationStatus;
  reason: string;
  source: string | null;
  reachability: string | null;
  test: { test_class: string; test_source: string } | null;
  head: ReproRun | null;
  base: ReproRun | null;
}

export interface Fix {
  group: string;
  asIs: Citation;
  toBe: string;
  explanation: string;
}

export interface Investigation {
  item: string;
  reasons: RouteReason[];
  kind: 'expand' | 'second-read' | 'none';
  rounds: number;
  snippets: number;
  agenticLookups: number;
  before: ItemStatus;
  after: ItemStatus;
  notInRepo: string[];
}

/** Everything the audit steps decide, persisted after each step so a resumed run continues from it. */
export interface AuditState {
  arm: ReviewArm;
  items: AuditItem[];
  regions: Region[];
  batches: AuditBatch[];
  /** region id -> artifact hash of its context pack text. */
  packs: Record<string, string>;
  packStats: Array<{ region: string; chars: number; hunksNotInlined: number; boundarySignals: number }>;
  rulesHash: string;
  ruleFiles: string[];
  outcomes: ItemOutcome[];
  candidates: Candidate[];
  investigations: Investigation[];
  groups: CandidateGroup[];
  verifications: Verification[];
  fixes: Fix[];
  /** Arm A: the unit results (ledger); B/C derive them from item outcomes. */
  unitResults: UnitResult[];
  calls: Array<{ step: string; ok: boolean; promptTokens: number; completionTokens: number; cachedPromptTokens: number; ms: number }>;
}

/** What the review package carries about an audit run (rendered in SUMMARY.md; compared across arms). */
export interface AuditSummary {
  arm: ReviewArm;
  armLabel: string;
  counts: Partial<Record<ItemStatus, number>>;
  items: Array<{ id: string; kind: ItemKind; mandatory: boolean; text: string; status: ItemStatus; evidence: number; routedFor: RouteReason[]; history: string[]; missing: string[]; notes: string[] }>;
  requirementIssues: Array<{ item: string; issue: string }>;
  candidates: { total: number; citationRejected: number; groups: number };
  verifications: Array<{ group: string; status: VerificationStatus; reason: string }>;
  investigations: Investigation[];
  packs: AuditState['packStats'];
  rulesHash: string;
  ruleFiles: string[];
  structuredCalls: { count: number; failed: number; promptTokens: number; cachedPromptTokens: number; completionTokens: number };
}

export interface AuditEnv {
  arm: ReviewArm;
  def: WorkflowDef;
  runner: StepRunner;
  deps: PrReviewDeps;
  runId: string;
  runDir: string;
  timeoutMs: number;
  keepWorkspaces: boolean;
  state: {
    readonly ws: Workspace;
    readonly files: FileDiff[];
    readonly hunks: Map<string, Hunk>;
    readonly blast: BlastRadius;
    readonly requirements: Requirements | null;
    readonly units: ReviewUnit[];
    readonly reproAllowed: boolean;
    readonly envSpec: EnvSpec | null;
    readonly head: string;
    readonly mergeBase: string;
  };
  requirementsText: (r: Requirements | null) => string;
  /** The pr-review agentic unit reviewer (arm A), with inline repro disabled. */
  agenticReview: (unit: ReviewUnit) => Promise<UnitResult>;
  /** Hands the derived findings, ledger and summary to the shared synthesis step. */
  publish: (r: { findings: Finding[]; reviewed: UnitResult[]; audit: AuditSummary }) => void;
}

const json = <T>(deps: PrReviewDeps, hash: string) => JSON.parse(deps.artifacts.read(hash).toString('utf8')) as T;

/** Step implementations for pr-review-audit (bound by runPrReview next to the shared steps). */
export function auditSteps(env: AuditEnv): Record<string, () => Promise<void>> {
  const { deps, runner, def, arm } = env;
  const log = deps.log ?? (() => undefined);
  let st!: AuditState;
  const save = (name: string) => deps.artifacts.putJson(`pr.audit.${name}`, st, { runId: env.runId, arm }).hash;
  const spent = () => {
    const u = deps.usage();
    return deps.budgetTokens !== undefined && u.promptTokens + u.completionTokens >= deps.budgetTokens;
  };
  const verify = (c: Citation) => verifyCitation(env.state.ws.dir, c.file, c.line, c.quote).ok;
  const itemById = (id: string) => st.items.find((i) => i.id === id);
  const outcomeOf = (id: string) => st.outcomes.find((o) => o.itemId === id)!;
  const setOutcome = (o: ItemOutcome) => {
    st.outcomes = st.outcomes.map((x) => (x.itemId === o.itemId ? o : x));
  };
  const addCandidate = (c: Omit<Candidate, 'id'>) => {
    st.candidates.push({ ...c, id: `C${st.candidates.length + 1}` });
  };
  const structured = (): StructuredCaller => {
    if (!deps.structured) throw new Error('the audit arms need a structured (single-pass) caller');
    return deps.structured;
  };
  const record = (step: string, r: StructuredResult) => {
    st.calls.push({ step, ok: r.ok, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, cachedPromptTokens: r.usage.cachedPromptTokens, ms: r.durationMs });
    runner.emit('STRUCTURED_CALL', { step, ok: r.ok, attempts: r.attempts, durationMs: r.durationMs, ...r.usage, errors: r.errors.slice(0, 3) });
  };
  const auditor = loadAgent(stepDef(def, 'audit').agent!);
  const responseFormat = stepParam<ResponseFormat>(def, 'audit', 'responseFormat', 'json_object');
  const sharedPrefix = () => [`## Requirements\n${env.requirementsText(env.state.requirements)}`, `## Item catalog\n${untrusted('items', itemCatalog(st.items))}`].join('\n\n');
  const packText = (region: string) => deps.artifacts.read(st.packs[region]!).toString('utf8');

  async function ask(stepId: string, region: string, tail: string, tier: string): Promise<AuditAnswer[] | null> {
    const r = await structured().call({
      runId: env.runId,
      stepId,
      tier,
      system: auditor.prompt,
      prefix: [sharedPrefix(), packText(region)],
      tail,
      schema: auditor.schema,
      responseFormat,
      maxRepairs: 1,
      timeoutMs: env.timeoutMs,
    });
    record(stepId, r);
    return r.ok ? (r.output as { results: AuditAnswer[] }).results : null;
  }

  const batchTail = (ids: string[], note = '') => `## Batch\n${note}Answer exactly these items, once each: ${ids.join(', ')}.`;

  function absorb(answers: AuditAnswer[], ids: string[], pass: string, origin: Candidate['origin']): void {
    for (const a of answers) {
      if (!ids.includes(a.item_id)) continue;
      const { outcome, candidate } = applyAnswer(outcomeOf(a.item_id), a, pass, verify);
      setOutcome(outcome);
      // A later pass with more context no longer sees the defect: the test still decides, but say so.
      if (a.verdict !== 'fail') for (const c of st.candidates.filter((x) => x.itemId === a.item_id)) c.notes.push(`${pass} with more context answered ${a.verdict}: ${a.rationale}`);
      if (candidate) addCandidate({ ...candidate, itemId: a.item_id, origin, evidence: outcome.evidence, notes: candidate.citationOk ? [] : ['cause citation did not match the code'] });
    }
  }

  return {
    // Arm A: the pr-review agentic unit reviewers. Their findings become candidates; nothing else.
    'agentic-review': async () => {
      const hash = await runner.step('agentic-review', async () => {
        st = emptyState(arm);
        if (arm !== 'A') return save('agentic');
        const results = await mapLimit(env.state.units, deps.config.review.maxWorkers, (u) => env.agenticReview(u));
        st.unitResults = results;
        for (const u of env.state.units) {
          const r = results.find((x) => x.unit === u.id);
          st.items.push({ id: u.id, kind: UNIT_ITEM_KIND[u.kind], lens: u.kind === 'T' ? 'code' : 'spec', text: `agentic review of unit ${u.id}`, source: u.id, region: '', highRisk: !!u.mandatory, mandatory: u.kind === 'T' || !!u.mandatory });
          const o = newOutcome(u.id);
          o.status = !r?.ok ? 'not_run' : r.findings.length ? 'fail' : 'pass';
          o.history = [`agentic:${o.status}`];
          if (r?.reason) o.notes.push(r.reason);
          st.outcomes.push(o);
          for (const f of r?.findings ?? []) {
            const cause = { file: f.file, line: f.line, quote: f.evidence_quote };
            const ok = verify(cause);
            addCandidate({
              title: f.title, severity: f.severity, class: classify(f.category, u.kind), category: f.category, invariant: f.explanation, entry_point: '', cause,
              failing_scenario: f.failing_scenario, itemId: u.id, origin: 'agentic', citationOk: ok, evidence: [], notes: ok ? [] : ['cause citation did not match the code'],
            });
          }
          for (const ac of r?.acStatus ?? []) if (ac.status === 'missing' || ac.status === 'partial') o.notes.push(`${ac.ac_id}: ${ac.status} (${ac.note})`);
        }
        return save('agentic');
      });
      st = json<AuditState>(deps, hash);
    },

    // Arms B and C: single-pass batches, one call per (region, lens). Cache hits are measured from
    // what the provider reports, never assumed.
    audit: async () => {
      const hash = await runner.step('audit', async () => {
        if (arm === 'A') return save('audit');
        const ws = env.state.ws.dir;
        const rules = readSpecRules(ws, specDirsFor(env.state.files, stepParam<string[]>(def, 'audit', 'specDirs', [])));
        const built = buildAuditItems({ units: env.state.units, requirements: env.state.requirements, viewpoints: loadViewpoints(def), rules });
        st.items = built.items;
        st.regions = built.regions;
        st.rulesHash = rules.hash;
        st.ruleFiles = rules.files;
        st.batches = planBatches(st.items, stepParam(def, 'audit', 'maxItemsPerBatch', 20));
        st.outcomes = st.items.map((i) => newOutcome(i.id));
        for (const region of st.regions) {
          const pack = await buildContextPack({
            workspace: ws,
            region,
            hunks: regionHunks(region, env.state.hunks),
            blast: env.state.blast,
            maxChars: stepParam(def, 'audit', 'maxPackChars', 120_000),
            maxCallers: stepParam(def, 'audit', 'maxCallers', 12),
            maxContractSnippets: stepParam(def, 'audit', 'maxContractSnippets', 6),
          });
          st.packs[region.id] = deps.artifacts.put('pr.audit.pack', pack.text, 'text/markdown', { runId: env.runId, region: region.id }).hash;
          st.packStats.push({ region: region.id, chars: pack.chars, hunksNotInlined: pack.hunksNotInlined.length, boundarySignals: pack.signals.length });
        }
        log(`  audit: ${st.items.length} item(s) in ${st.batches.length} batch(es) over ${st.regions.length} region(s)`);
        const tier = stepDef(def, 'audit').tier ?? 'tier-workhorse';
        const runBatch = async (b: AuditBatch) => {
          if (spent()) {
            for (const id of b.itemIds) setOutcome({ ...outcomeOf(id), notes: [...outcomeOf(id).notes, 'not audited: token budget exhausted'] });
            return;
          }
          const answers = await ask(`audit-${b.id}`, b.region, batchTail(b.itemIds), tier);
          if (!answers) {
            for (const id of b.itemIds) setOutcome({ ...outcomeOf(id), notes: [...outcomeOf(id).notes, `batch ${b.id} failed`] });
            return;
          }
          absorb(answers, b.itemIds, 'audit', 'audit');
          const { missing } = coverage(b.itemIds, answers);
          if (!missing.length || spent()) return;
          runner.emit('LEDGER_GAP', { batch: b.id, missing });
          const again = await ask(`audit-${b.id}-cover`, b.region, batchTail(missing, 'Your previous answer skipped these items. '), tier);
          if (again) absorb(again, missing, 'audit-cover', 'audit');
        };
        const byRegion = new Map<string, AuditBatch[]>();
        for (const b of st.batches) byRegion.set(b.region, [...(byRegion.get(b.region) ?? []), b]);
        // Regions run in parallel (maxWorkers); a region's batches run in order, so concurrency stays
        // at maxWorkers and every batch after the first can find the region's prefix cached.
        await mapLimit([...byRegion.values()], deps.config.review.maxWorkers, async (list) => {
          for (const b of list) await runBatch(b);
        });
        return save('audit');
      });
      st = json<AuditState>(deps, hash);
    },

    investigate: async () => {
      const hash = await runner.step('investigate', async () => {
        const routes = routeItems(
          st.items,
          new Map(st.outcomes.map((o) => [o.itemId, o])),
          (id) => st.candidates.some((c) => c.itemId === id && c.citationOk),
          { arm, auditSampleRate: stepParam(def, 'investigate', 'auditSampleRate', 0.1), secondReadHighRisk: stepParam(def, 'investigate', 'secondReadHighRisk', true) },
          env.runId,
        );
        for (const [id, reasons] of routes) setOutcome({ ...outcomeOf(id), routedFor: reasons });
        if (arm !== 'C') return save('investigate');

        const PRIORITY: RouteReason[] = ['missing_context', 'cross_service_unknown', 'high_risk', 'audit_sample'];
        const work = [...routes.entries()]
          .filter(([, r]) => r.some((x) => x !== 'candidate'))
          .sort((a, b) => Math.min(...a[1].map((r) => PRIORITY.indexOf(r)).filter((i) => i >= 0)) - Math.min(...b[1].map((r) => PRIORITY.indexOf(r)).filter((i) => i >= 0)));
        const cap = stepParam(def, 'investigate', 'maxInvestigations', 30);
        for (const [id] of work.slice(cap)) {
          const o = outcomeOf(id);
          setOutcome({ ...o, status: o.status === 'cannot_determine' ? 'unresolved' : o.status, notes: [...o.notes, `not investigated: more than ${cap} items needed investigation`] });
        }
        await mapLimit(work.slice(0, cap), deps.config.review.maxWorkers, async ([id, reasons]) => {
          const item = itemById(id);
          if (!item) return;
          if (spent()) {
            const o = outcomeOf(id);
            setOutcome({ ...o, status: o.status === 'cannot_determine' ? 'unresolved' : o.status, notes: [...o.notes, 'not investigated: token budget exhausted'] });
            return;
          }
          const inv = reasons.includes('missing_context') || reasons.includes('cross_service_unknown') ? await expand(item, reasons) : await secondRead(item, reasons);
          st.investigations.push(inv);
        });
        return save('investigate');
      });
      st = json<AuditState>(deps, hash);
    },

    group: async () => {
      const hash = await runner.step('group', async () => {
        st.groups = groupByRootCause(st.candidates, (c) => enclosingSymbol(env.state.ws.dir, c.file, c.line), stepParam(def, 'group', 'similarity', 0.3));
        runner.emit('CANDIDATES_GROUPED', { candidates: st.candidates.length, rejected: st.candidates.filter((c) => !c.citationOk).length, groups: st.groups.length });
        return save('group');
      });
      st = json<AuditState>(deps, hash);
    },

    // Same policy in every arm: a business/technical group is confirmed only by a test that fails
    // on head through an assertion, against a stated expected behaviour.
    verify: async () => {
      const hash = await runner.step('verify', async () => {
        const max = stepParam(def, 'verify', 'maxVerifications', 10);
        const spec = loadAgent(stepDef(def, 'verify').agent!);
        let headWs: Workspace | null = null;
        let baseWs: Workspace | null = null;
        const ordered = [...st.groups].sort((a, b) => a.severity.localeCompare(b.severity));
        let tested = 0;
        for (const g of ordered) {
          const v = (status: VerificationStatus, reason: string, extra: Partial<Verification> = {}): Verification => ({ group: g.id, status, reason, source: null, reachability: null, test: null, head: null, base: null, ...extra });
          if (g.class === 'convention') {
            st.verifications.push(v('explained', 'convention issue: explained with its cited rule, no test required'));
            continue;
          }
          if (!env.state.reproAllowed || !env.state.envSpec) {
            st.verifications.push(v('blocked', 'no approved L2 test environment for this repository (GATE_ENV)'));
            continue;
          }
          if (tested >= max) {
            st.verifications.push(v('not-verified', `verification limit of ${max} reached`));
            continue;
          }
          if (spent()) {
            st.verifications.push(v('blocked', 'token budget exhausted'));
            continue;
          }
          tested++;
          const r: AgentResult = await deps.reviewer.run({
            runId: env.runId,
            stepId: `verify-${g.id}`,
            instructions: fillVerifier(spec.prompt, g, st, env),
            outputSchema: spec.schema,
            scope: 'read-repo',
            cwd: env.state.ws.dir,
            stateDir: join(env.runDir, 'agents', `verify-${g.id}`),
            tier: stepDef(def, 'verify').tier ?? 'tier-workhorse',
            timeoutMs: env.timeoutMs,
          });
          runner.emit('AGENT_RUN', { step: `verify-${g.id}`, executor: deps.reviewer.id, agentVersion: spec.version, ok: r.ok, attempts: r.attempts, durationMs: r.durationMs, errors: r.errors.slice(0, 5) });
          if (!r.ok) {
            st.verifications.push(v('blocked', `verifier did not produce a valid answer: ${r.errors.at(-1) ?? 'unknown error'}`));
            continue;
          }
          const out = r.output as VerifierOutput;
          const source = checkSource(out.expected_source, st, env);
          const extra = { source: source.label, reachability: out.reachability, test: out.test };
          if (!source.ok) {
            st.verifications.push(v('blocked', `no valid source for the expected behaviour (${source.reason})`, extra));
            continue;
          }
          if (!out.test) {
            st.verifications.push(v('blocked', out.blocked_reason ?? 'verifier wrote no test', extra));
            continue;
          }
          headWs ??= await deps.target.prepare({ runId: env.runId, repo: deps.repo.name, sha: env.state.head, slot: 'evidence', reuse: true });
          const onHead = await runJavaRepro(deps.target, headWs, env.state.envSpec, g.cause.file, out.test.test_class, out.test.test_source, env.timeoutMs);
          runner.emit('REPRO_RUN', { finding: g.id, evidence: onHead.outcome, headMs: onHead.durationMs });
          if (onHead.outcome === 'GREEN') {
            st.verifications.push(v('withdrawn', `test passes on the PR head: ${onHead.reason}`, { ...extra, head: onHead }));
            continue;
          }
          if (onHead.outcome === 'INCONCLUSIVE') {
            st.verifications.push(v('unconfirmed', `test did not run: ${onHead.reason}`, { ...extra, head: onHead }));
            continue;
          }
          if (!onHead.assertionsOnly) {
            st.verifications.push(v('unconfirmed', `test failed with an exception, not an assertion (setup or mock problem until shown otherwise): ${onHead.reason}`, { ...extra, head: onHead }));
            continue;
          }
          baseWs ??= await deps.target.prepare({ runId: env.runId, repo: deps.repo.name, sha: env.state.mergeBase, slot: 'evidence-base', reuse: true });
          const onBase = await runJavaRepro(deps.target, baseWs, env.state.envSpec, g.cause.file, out.test.test_class, out.test.test_source, env.timeoutMs);
          st.verifications.push(
            onBase.outcome === 'RED'
              ? v('confirmed-preexisting', `assertion fails on head and on the merge base: ${onHead.reason}`, { ...extra, head: onHead, base: onBase })
              : v('confirmed', `assertion fails on head${onBase.outcome === 'GREEN' ? ' and passes on the merge base' : ` (merge base: ${onBase.outcome})`}: ${onHead.reason}`, { ...extra, head: onHead, base: onBase }),
          );
        }
        if (!env.keepWorkspaces) for (const w of [headWs, baseWs]) if (w) await deps.target.destroy(w);
        return save('verify');
      });
      st = json<AuditState>(deps, hash);
    },

    // AS-IS / TO-BE only now, for what survived verification.
    'propose-fix': async () => {
      const hash = await runner.step('propose-fix', async () => {
        const spec = loadAgent(stepDef(def, 'propose-fix').agent!);
        const ready = st.groups.filter((g) => ['confirmed', 'confirmed-preexisting', 'explained'].includes(st.verifications.find((v) => v.group === g.id)?.status ?? ''));
        if (!deps.structured) return save('fix');
        await mapLimit(ready, deps.config.review.maxWorkers, async (g) => {
          if (spent()) return;
          const code = snippet(env.state.ws.dir, g.cause.file, g.cause.line, 15, 15, 'code to change');
          const r = await deps.structured!.call({
            runId: env.runId,
            stepId: `fix-${g.id}`,
            tier: stepDef(def, 'propose-fix').tier ?? 'tier-workhorse',
            system: spec.prompt,
            prefix: [],
            tail: [
              `## Finding ${g.id} [${g.severity}, ${g.class}] ${g.title}`,
              `Violated rule: ${g.invariant}`,
              `Failing scenario: ${g.failingScenario}`,
              `Verification: ${st.verifications.find((v) => v.group === g.id)?.reason ?? ''}`,
              code ? renderSnippets([code]) : '',
            ].join('\n'),
            schema: spec.schema,
            responseFormat,
            timeoutMs: env.timeoutMs,
          });
          record(`fix-${g.id}`, r);
          if (!r.ok) return;
          const out = r.output as { as_is: Citation; to_be: string; explanation: string };
          if (verify(out.as_is)) st.fixes.push({ group: g.id, asIs: out.as_is, toBe: out.to_be, explanation: out.explanation });
        });
        return save('fix');
      });
      st = json<AuditState>(deps, hash);
      env.publish(derive(st, env));
    },
  };

  /** Arm C: read what the item said was missing, then ask again about that item alone. */
  async function expand(item: AuditItem, reasons: RouteReason[]): Promise<Investigation> {
    const rounds = stepParam(def, 'investigate', 'expansionRounds', 2);
    const tier = stepDef(def, 'audit').tier ?? 'tier-workhorse';
    const before = outcomeOf(item.id).status;
    const seen = new Set<string>();
    const gathered: Snippet[] = [];
    const notInRepo: string[] = [];
    let agentic = 0;
    let r = 0;
    for (r = 1; r <= rounds; r++) {
      const o = outcomeOf(item.id);
      const signalNames = reasons.includes('cross_service_unknown') ? boundaryLookups(st, item, packText) : [];
      const lookups = [...o.missingContext.flatMap((m) => m.lookup), ...signalNames];
      const found = await resolveLookups(env.state.ws.dir, lookups, { maxPerLookup: 2, maxSnippets: 8, exclude: seen });
      let fresh = found.snippets;
      if (!fresh.length && stepParam(def, 'investigate', 'agenticLookup', true) && o.missingContext.length) {
        agentic++;
        const located = await investigator(item, o);
        fresh = located.snippets.filter((s) => !seen.has(`${s.file}:${s.from}`));
        notInRepo.push(...located.notInRepo);
      }
      if (!fresh.length) {
        notInRepo.push(...found.notFound.map((l) => `\`${l}\` not found in this repository`));
        break;
      }
      for (const s of fresh) seen.add(`${s.file}:${s.from}`);
      gathered.push(...fresh);
      const questions = o.missingContext.map((m) => `- (${m.need}) ${m.question}`).join('\n') || '- cross-service impact was unknown';
      const answers = await ask(
        `expand-${item.id}-${r}`,
        item.region,
        `## Additional context for ${item.id}\n${renderSnippets(gathered)}\n\n## Batch\nYou could not fully decide item ${item.id} before. What was missing:\n${questions}\nWith the additional context above, answer item ${item.id} only. If something is still missing, say exactly what in missing_context.`,
        tier,
      );
      if (!answers) break;
      absorb(answers, [item.id], `expand#${r}`, 'expand');
      const after = outcomeOf(item.id);
      if (after.status !== 'cannot_determine' && !after.missingContext.length && after.crossService !== 'unknown') break;
    }
    const o = outcomeOf(item.id);
    if (o.status === 'cannot_determine' || (o.status !== 'fail' && o.missingContext.length)) {
      setOutcome({ ...o, status: o.status === 'cannot_determine' ? 'unresolved' : o.status, notes: [...o.notes, `still missing after expansion: ${o.missingContext.map((m) => m.question).join('; ') || 'cross-service contract'}`, ...notInRepo] });
    }
    return { item: item.id, reasons, kind: 'expand', rounds: Math.min(r, rounds), snippets: gathered.length, agenticLookups: agentic, before, after: outcomeOf(item.id).status, notInRepo };
  }

  /** Arm C: an independent read of a high-risk or sampled "no finding" item. */
  async function secondRead(item: AuditItem, reasons: RouteReason[]): Promise<Investigation> {
    const before = outcomeOf(item.id).status;
    const answers = await ask(
      `second-${item.id}`,
      item.region,
      `## Batch\nIndependent check of item ${item.id}. Judge it from the code in the pack only; earlier answers are not shown to you on purpose. Answer item ${item.id} only.`,
      stepParam(def, 'investigate', 'secondReadTier', stepDef(def, 'audit').tier ?? 'tier-workhorse'),
    );
    const a = answers?.find((x) => x.item_id === item.id);
    const o = outcomeOf(item.id);
    if (a && a.verdict !== before) {
      if (a.verdict === 'fail') {
        absorb([a], [item.id], 'second-read', 'second-read');
        const after = outcomeOf(item.id);
        setOutcome({ ...after, notes: [...after.notes, `first read said ${before}; an independent second read found a problem`] });
      } else {
        setOutcome({ ...o, history: [...o.history, `second-read:${a.verdict}`], notes: [...o.notes, `second read disagrees (${a.verdict}): ${a.rationale}`] });
      }
    } else if (a) {
      setOutcome({ ...o, history: [...o.history, `second-read:${a.verdict}`] });
    }
    return { item: item.id, reasons, kind: 'second-read', rounds: 1, snippets: 0, agenticLookups: 0, before, after: outcomeOf(item.id).status, notInRepo: [] };
  }

  async function investigator(item: AuditItem, o: ItemOutcome): Promise<{ snippets: Snippet[]; notInRepo: string[] }> {
    const spec = loadAgent(stepDef(def, 'investigate').agent!);
    const r = await deps.reviewer.run({
      runId: env.runId,
      stepId: `lookup-${item.id}`,
      instructions: spec.prompt
        .replace('{{item}}', untrusted(`item:${item.id}`, `${item.id}: ${item.text}`))
        .replace('{{questions}}', o.missingContext.map((m) => `- (${m.need}) ${m.question}${m.lookup.length ? ` — try: ${m.lookup.join(', ')}` : ''}`).join('\n')),
      outputSchema: spec.schema,
      scope: 'read-repo',
      cwd: env.state.ws.dir,
      stateDir: join(env.runDir, 'agents', `lookup-${item.id}`),
      tier: stepDef(def, 'investigate').tier ?? 'tier-workhorse',
      timeoutMs: env.timeoutMs,
    });
    runner.emit('AGENT_RUN', { step: `lookup-${item.id}`, executor: deps.reviewer.id, agentVersion: spec.version, ok: r.ok, attempts: r.attempts, durationMs: r.durationMs, errors: r.errors.slice(0, 5) });
    if (!r.ok) return { snippets: [], notInRepo: [] };
    const out = r.output as { found: Array<Citation & { answers: string }>; not_in_repo: string[] };
    const snippets = out.found
      .filter((f) => verify(f))
      .map((f) => snippet(env.state.ws.dir, f.file, f.line, 6, 12, `investigator: ${f.answers}`.slice(0, 120)))
      .filter((s): s is Snippet => !!s);
    return { snippets, notInRepo: out.not_in_repo };
  }
}

const UNIT_ITEM_KIND: Record<UnitKind, ItemKind> = { T: 'technical', B: 'business', V: 'viewpoint', S: 'seam' };

function emptyState(arm: ReviewArm): AuditState {
  return { arm, items: [], regions: [], batches: [], packs: {}, packStats: [], rulesHash: '', ruleFiles: [], outcomes: [], candidates: [], investigations: [], groups: [], verifications: [], fixes: [], unitResults: [], calls: [] };
}

function loadViewpoints(def: WorkflowDef) {
  return loadRiskRouting(stepParam(def, 'plan', 'routing', 'risk-routing'));
}

/** Names to look up for an item whose cross-service impact was unknown: the region's boundary signals. */
function boundaryLookups(st: AuditState, item: AuditItem, packText: (region: string) => string): string[] {
  const text = st.packs[item.region] ? packText(item.region) : '';
  const names = [...text.matchAll(/\(names: ([^)]+)\)/g)].flatMap((m) => m[1]!.split(', '));
  return [...new Set(names)].slice(0, 6);
}

interface VerifierOutput {
  expected_source: { kind: 'requirement' | 'rule' | 'contract' | 'code' | 'none'; ref: string | null; file: string | null; line: number | null; quote: string | null };
  reachability: string;
  test: { test_class: string; test_source: string } | null;
  blocked_reason: string | null;
}

function fillVerifier(prompt: string, g: CandidateGroup, st: AuditState, env: AuditEnv): string {
  const items = g.items.map((id) => st.items.find((i) => i.id === id)).filter((i): i is AuditItem => !!i);
  const finding = [
    `id: ${g.id}`,
    `[${g.severity}, ${g.class}] ${g.title}`,
    `violated rule: ${g.invariant}`,
    `cause: ${g.cause.file}:${g.cause.line}: ${g.cause.quote}`,
    `entry points: ${g.entryPoints.join(', ') || 'unknown'}`,
    `other locations: ${g.locations.map((l) => `${l.file}:${l.line}`).join(', ')}`,
    `failing scenario: ${g.failingScenario}`,
  ].join('\n');
  return prompt
    .replace('{{finding}}', untrusted(`finding:${g.id}`, finding))
    .replace('{{requirements}}', env.requirementsText(env.state.requirements))
    .replace('{{rules}}', items.length ? untrusted('rules', items.map((i) => `- ${i.id}: ${i.text}`).join('\n')) : '_none_');
}

/** The expected behaviour must come from somewhere checkable: a known rule id, or a citation that matches the code. */
function checkSource(s: VerifierOutput['expected_source'], st: AuditState, env: AuditEnv): { ok: boolean; reason: string; label: string | null } {
  if (s.kind === 'none') return { ok: false, reason: 'verifier found no statement of the expected behaviour', label: null };
  if (s.kind === 'requirement' || s.kind === 'rule') {
    const known = new Set([...st.items.map((i) => i.id), ...(env.state.requirements?.acceptance_criteria ?? []).map((a) => a.id)]);
    return s.ref && known.has(s.ref) ? { ok: true, reason: '', label: `${s.kind} ${s.ref}` } : { ok: false, reason: `unknown ${s.kind} id ${s.ref ?? '(none)'}`, label: null };
  }
  if (!s.file || !s.line || !s.quote) return { ok: false, reason: `${s.kind} source without a citation`, label: null };
  return verifyCitation(env.state.ws.dir, s.file, s.line, s.quote).ok
    ? { ok: true, reason: '', label: `${s.kind} ${s.file}:${s.line}` }
    : { ok: false, reason: `${s.kind} citation ${s.file}:${s.line} does not match the code`, label: null };
}

const STATUS_EVIDENCE: Record<VerificationStatus, Evidence> = {
  confirmed: 'REPRO_RED',
  'confirmed-preexisting': 'REPRO_RED_BOTH',
  withdrawn: 'REPRO_GREEN',
  unconfirmed: 'REPRO_INCONCLUSIVE',
  blocked: 'CITED',
  explained: 'CITED',
  'not-verified': 'CITED',
};
const STATUS_VERDICT: Record<VerificationStatus, FindingVerdict> = {
  confirmed: 'STANDS',
  'confirmed-preexisting': 'STANDS',
  explained: 'STANDS',
  withdrawn: 'WITHDRAWN',
  unconfirmed: 'UNCHALLENGED',
  blocked: 'UNCHALLENGED',
  'not-verified': 'UNCHALLENGED',
};

/** Findings, ledger and summary for synthesis; a pure function of the persisted state. */
export function derive(st: AuditState, env: Pick<AuditEnv, 'state' | 'arm'>): { findings: Finding[]; reviewed: UnitResult[]; audit: AuditSummary } {
  const commentable = new Map<string, Set<number>>();
  for (const f of env.state.files) commentable.set(f.file, new Set(f.hunks.flatMap((h) => h.commentable)));
  const findings: Finding[] = st.groups.map((g) => {
    const v = st.verifications.find((x) => x.group === g.id);
    const status = v?.status ?? 'not-verified';
    const fix = st.fixes.find((x) => x.group === g.id);
    const members = st.candidates.filter((c) => g.members.includes(c.id));
    return {
      id: g.id,
      unit: g.items.join(', '),
      title: g.title,
      severity: g.severity,
      category: `${g.class}/${g.category}`,
      file: g.cause.file,
      line: g.cause.line,
      evidence_quote: g.cause.quote,
      explanation: `Violated rule: ${g.invariant}${g.entryPoints.length ? ` (entry: ${g.entryPoints.join(', ')})` : ''}`,
      failing_scenario: g.failingScenario,
      suggested_fix: fix ? `AS-IS \`${fix.asIs.file}:${fix.asIs.line}\`: ${fix.asIs.quote}\nTO-BE:\n${fix.toBe}\n${fix.explanation}` : '',
      repro: v?.test ?? null,
      evidence: STATUS_EVIDENCE[status],
      verdict: STATUS_VERDICT[status],
      inDiff: commentable.get(g.cause.file)?.has(g.cause.line) ?? false,
      notes: [
        `Verification: ${status}${v ? ` — ${v.reason}` : ''}`,
        ...(v?.source ? [`Expected behaviour from ${v.source}`] : []),
        ...(g.locations.length > 1 ? [`Same root cause at ${g.locations.slice(1).map((l) => `${l.file}:${l.line}`).join(', ')}`] : []),
        ...(members.length ? [`Reported by: ${[...new Set(members.map((m) => m.origin))].join(', ')}`] : []),
      ],
      ...(g.members.length > 1 ? { mergedFrom: g.members.slice(1) } : {}),
      status,
      items: g.items,
    };
  });
  let n = st.groups.length;
  for (const c of st.candidates.filter((x) => !x.citationOk)) {
    findings.push({
      id: `G${++n}`, unit: c.itemId, title: c.title, severity: c.severity, category: `${c.class}/${c.category}`, file: c.cause.file, line: c.cause.line,
      evidence_quote: c.cause.quote, explanation: c.invariant, failing_scenario: c.failing_scenario, suggested_fix: '', repro: null,
      evidence: 'NO_EVIDENCE', verdict: 'REJECTED', inDiff: false, notes: ['Citation rejected: the cited cause does not match the code'], items: [c.itemId],
    });
  }

  const reviewed: UnitResult[] =
    env.arm === 'A'
      ? st.unitResults
      : env.state.units
          .filter((u) => u.kind === 'T')
          .map((u) => {
            const o = st.outcomes.find((x) => x.itemId === `${u.id}.tech`);
            const ok = !!o && ['pass', 'fail', 'not_applicable'].includes(o.status);
            return { unit: u.id, kind: 'T' as const, ok, reviewed: ok ? u.hunkIds : [], findings: [], ...(ok ? {} : { reason: `item ${u.id}.tech is ${o?.status ?? 'missing'}` }) };
          });

  const counts: Partial<Record<ItemStatus, number>> = {};
  for (const o of st.outcomes) counts[o.status] = (counts[o.status] ?? 0) + 1;
  const sum = (k: 'promptTokens' | 'completionTokens' | 'cachedPromptTokens') => st.calls.reduce((x, c) => x + c[k], 0);
  return {
    findings,
    reviewed,
    audit: {
      arm: st.arm,
      armLabel: ARM_LABEL[st.arm],
      counts,
      items: st.items.map((i) => {
        const o = st.outcomes.find((x) => x.itemId === i.id)!;
        return { id: i.id, kind: i.kind, mandatory: i.mandatory, text: i.text, status: o.status, evidence: o.evidence.length, routedFor: o.routedFor, history: o.history, missing: o.missingContext.map((m) => `(${m.need}) ${m.question}`), notes: o.notes };
      }),
      requirementIssues: st.outcomes.filter((o) => o.requirementIssue).map((o) => ({ item: o.itemId, issue: o.requirementIssue! })),
      candidates: { total: st.candidates.length, citationRejected: st.candidates.filter((c) => !c.citationOk).length, groups: st.groups.length },
      verifications: st.verifications.map((v) => ({ group: v.group, status: v.status, reason: v.reason })),
      investigations: st.investigations,
      packs: st.packStats,
      rulesHash: st.rulesHash,
      ruleFiles: st.ruleFiles,
      structuredCalls: { count: st.calls.length, failed: st.calls.filter((c) => !c.ok).length, promptTokens: sum('promptTokens'), cachedPromptTokens: sum('cachedPromptTokens'), completionTokens: sum('completionTokens') },
    },
  };
}

/** Items whose result counts against completeness: mandatory items that were never decided. */
export function auditIncomplete(audit: AuditSummary): string[] {
  return audit.items
    .filter((i) => i.mandatory && ['cannot_determine', 'unresolved', 'not_run'].includes(i.status))
    .map((i) => `${i.id} ${i.status === 'not_run' ? 'was not audited' : i.status === 'unresolved' ? 'is unresolved after investigation' : 'could not be determined'}`);
}
