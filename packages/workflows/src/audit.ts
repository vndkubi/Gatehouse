import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@gatehouse/core';
import type { FileDiff, Hunk } from './diff.ts';
import type { Severity } from './findings.ts';
import type { Requirements } from './package.ts';
import type { ReviewUnit } from './plan.ts';
import type { Viewpoint } from './routing.ts';

/**
 * Batched audit (design 09). Review is split into checkable items; each item gets a verdict
 * from a single-pass, schema-bound call over a deterministic context pack. Agents and tests are
 * spent afterwards, on the items that need them: candidates, missing context, unknown
 * cross-service impact, high-risk items and a sample of "no problem found".
 */

/** Which pipeline produced the candidates (the A/B/C experiment, design 09 §5). */
export type ReviewArm = 'A' | 'B' | 'C';
export const ARM_LABEL: Record<ReviewArm, string> = {
  A: 'agentic reviewer (baseline)',
  B: 'fixed-context single pass + verification',
  C: 'single pass + context expansion + audit of high-risk and no-finding items',
};

export type ItemKind = 'technical' | 'convention' | 'business' | 'checklist' | 'scenario' | 'decision' | 'viewpoint' | 'seam';
/** code: read the diff as code (technical, clean code). spec: check the change against a rule. */
export type Lens = 'code' | 'spec';

export interface AuditItem {
  id: string;
  kind: ItemKind;
  lens: Lens;
  text: string;
  /** Where the rule comes from: AC id, checklist file, viewpoint id, plan unit. */
  source: string;
  region: string;
  /** High risk: a mandatory viewpoint, or a business rule touching risky files. Gets an independent second read in arm C. */
  highRisk: boolean;
  /** Fail-closed: an unresolved result marks the review incomplete. */
  mandatory: boolean;
}

export interface Region {
  id: string;
  hunkIds: string[];
  files: string[];
  /** Seam regions: usage sites outside the diff. */
  usages?: Array<{ file: string; line: number; text: string }>;
}

export interface AuditBatch {
  id: string;
  region: string;
  lens: Lens;
  itemIds: string[];
}

export type AuditVerdict = 'pass' | 'fail' | 'not_applicable' | 'cannot_determine';

export interface Citation {
  file: string;
  line: number;
  quote: string;
}

export interface MissingContext {
  need: 'contract' | 'owner' | 'config' | 'caller' | 'callee' | 'schema' | 'policy' | 'test' | 'other';
  question: string;
  lookup: string[];
}

export type CandidateClass = 'business' | 'technical' | 'convention';

export interface RawCandidate {
  title: string;
  severity: Severity;
  class: CandidateClass;
  category: string;
  invariant: string;
  entry_point: string;
  cause: Citation;
  failing_scenario: string;
}

/** One item's answer, as the auditor returns it (validated against batch-auditor's schema). */
export interface AuditAnswer {
  item_id: string;
  verdict: AuditVerdict;
  evidence: Citation[];
  rationale: string;
  missing_context: MissingContext[];
  cross_service: 'none' | 'affected' | 'unknown';
  requirement_issue: string | null;
  candidate: RawCandidate | null;
}

/** Why an item is sent to investigation (design 09 §3). */
export type RouteReason = 'candidate' | 'missing_context' | 'cross_service_unknown' | 'high_risk' | 'audit_sample';

export type ItemStatus = AuditVerdict | 'unresolved' | 'not_run';

export interface ItemOutcome {
  itemId: string;
  status: ItemStatus;
  evidence: Citation[];
  rationale: string;
  missingContext: MissingContext[];
  crossService: AuditAnswer['cross_service'];
  requirementIssue: string | null;
  /** Each pass over the item, in order: "audit:pass", "expand#1:fail", "second-read:pass", ... */
  history: string[];
  routedFor: RouteReason[];
  /** Why it ended unresolved / not run, or notes from the checks. */
  notes: string[];
}

export interface Candidate extends RawCandidate {
  id: string;
  itemId: string;
  /** Which pass reported it. */
  origin: 'audit' | 'expand' | 'second-read' | 'agentic';
  citationOk: boolean;
  /** Supporting citations from the item's evidence. */
  evidence: Citation[];
  notes: string[];
}

// ---- Items -------------------------------------------------------------------------------------

/** Rules the team keeps next to the code (Spec Kit layout): checklists, acceptance scenarios, decision tables. */
export interface SpecRules {
  checklists: Array<{ id: string; file: string; text: string }>;
  scenarios: Array<{ id: string; file: string; text: string }>;
  decisions: Array<{ id: string; file: string; text: string }>;
  /** Hash over every file read: the rules' cache key changes when any source changes. */
  hash: string;
  files: string[];
}

/** Spec feature directories the PR touches (`specs/<feature>/...`), or the ones named. */
export function specDirsFor(files: FileDiff[], explicit: string[] = []): string[] {
  if (explicit.length) return explicit;
  const dirs = new Set<string>();
  for (const f of files) {
    const m = /^(specs\/[^/]+)\//.exec(f.file);
    if (m) dirs.add(m[1]!);
  }
  return [...dirs].sort();
}

/** Deterministic parse of Spec Kit artifacts. No LLM: rules depend only on these files. */
export function readSpecRules(workspace: string, dirs: string[]): SpecRules {
  const out: SpecRules = { checklists: [], scenarios: [], decisions: [], hash: '', files: [] };
  const contents: string[] = [];
  for (const dir of dirs) {
    const abs = join(workspace, dir);
    if (!existsSync(abs)) continue;
    const checklistDir = join(abs, 'checklists');
    const checklistFiles = existsSync(checklistDir) ? readdirSync(checklistDir).filter((f) => f.endsWith('.md')).sort() : [];
    for (const name of checklistFiles) {
      const rel = `${dir}/checklists/${name}`;
      const text = readFileSync(join(checklistDir, name), 'utf8');
      contents.push(rel, text);
      out.files.push(rel);
      const stem = name.replace(/\.md$/, '');
      let n = 0;
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*[-*]\s+\[[ xX]\]\s+(?:(CHK\d+)\s+)?(.+?)\s*$/.exec(line);
        if (!m) continue;
        n++;
        out.checklists.push({ id: `${stem}:${m[1] ?? `CHK${String(n).padStart(3, '0')}`}`, file: rel, text: m[2]! });
      }
    }
    const specFile = join(abs, 'spec.md');
    if (existsSync(specFile)) {
      const rel = `${dir}/spec.md`;
      const text = readFileSync(specFile, 'utf8');
      contents.push(rel, text);
      out.files.push(rel);
      let heading = '';
      let header: string[] | null = null;
      for (const line of text.split(/\r?\n/)) {
        if (/^#{1,6}\s/.test(line)) {
          heading = line;
          header = null;
          continue;
        }
        const scenario = /^\s*\d+\.\s+(\*\*Given\*\*.+)$/.exec(line);
        if (scenario) out.scenarios.push({ id: `SC${out.scenarios.length + 1}`, file: rel, text: scenario[1]!.replace(/\*\*/g, '') });
        // Decision tables: every data row of a markdown table under a heading that names one.
        if (/decision|matrix|business rule/i.test(heading) && /^\s*\|/.test(line)) {
          const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
          if (!header) {
            header = cells;
            continue;
          }
          out.decisions.push({ id: `DT${out.decisions.length + 1}`, file: rel, text: header.map((h, i) => `${h} = ${cells[i] ?? ''}`).join('; ') });
        }
      }
    }
  }
  out.hash = sha256Hex(contents.join('\u0000')).slice(0, 16);
  return out;
}

const RISKY = /(auth|payment|money|security|crypto|data-integrity)/;

/**
 * Turns the plan units and the rules into checkable items, each assigned to the region whose
 * code it is checked against. Items in one region share a context pack (and the provider's
 * prefix cache); regions follow code that changes together, not a fixed item count.
 */
export function buildAuditItems(input: {
  units: ReviewUnit[];
  requirements: Requirements | null;
  viewpoints: Viewpoint[];
  rules: SpecRules;
}): { items: AuditItem[]; regions: Region[] } {
  const items: AuditItem[] = [];
  const regions: Region[] = [];
  const tUnits = input.units.filter((u) => u.kind === 'T');
  for (const u of tUnits) regions.push({ id: `R-${u.id}`, hunkIds: u.hunkIds, files: u.files });
  const allHunks = tUnits.flatMap((u) => u.hunkIds);
  const allRegion = tUnits.length === 1 ? `R-${tUnits[0]!.id}` : 'R-ALL';
  if (tUnits.length !== 1) regions.push({ id: 'R-ALL', hunkIds: allHunks, files: [...new Set(tUnits.flatMap((u) => u.files))] });
  const riskyDiff = tUnits.some((u) => u.riskTags.some((t) => RISKY.test(t)));

  for (const u of tUnits) {
    items.push({ id: `${u.id}.tech`, kind: 'technical', lens: 'code', source: u.id, region: `R-${u.id}`, highRisk: u.riskTags.length > 0, mandatory: true, text: `Hunks ${u.hunkIds.join(', ')}: incorrect behaviour, broken error handling, concurrency, security or contract breaks introduced by the change.` });
    items.push({ id: `${u.id}.conv`, kind: 'convention', lens: 'code', source: u.id, region: `R-${u.id}`, highRisk: false, mandatory: false, text: `Hunks ${u.hunkIds.join(', ')}: clean-code and convention problems a reviewer would ask to fix (naming, duplication, dead code, misleading comments, inconsistent patterns). Cite the convention you rely on.` });
  }
  for (const ac of input.requirements?.acceptance_criteria ?? []) {
    items.push({ id: ac.id, kind: 'business', lens: 'spec', source: 'requirements', region: allRegion, highRisk: riskyDiff, mandatory: false, text: ac.text });
  }
  for (const c of input.rules.checklists) items.push({ id: c.id, kind: 'checklist', lens: 'spec', source: c.file, region: allRegion, highRisk: riskyDiff, mandatory: false, text: c.text });
  for (const s of input.rules.scenarios) items.push({ id: s.id, kind: 'scenario', lens: 'spec', source: s.file, region: allRegion, highRisk: riskyDiff, mandatory: false, text: s.text });
  for (const d of input.rules.decisions) items.push({ id: d.id, kind: 'decision', lens: 'spec', source: d.file, region: allRegion, highRisk: riskyDiff, mandatory: false, text: d.text });

  for (const u of input.units.filter((x) => x.kind === 'V')) {
    const v = input.viewpoints.find((x) => x.id === u.viewpoint);
    if (!v) continue;
    // Reuse a technical region (and its cached pack) when the viewpoint's hunks sit inside one.
    const host = tUnits.find((t) => u.hunkIds.every((h) => t.hunkIds.includes(h)));
    const region = host ? `R-${host.id}` : `R-${u.id}`;
    if (!host) regions.push({ id: region, hunkIds: u.hunkIds, files: u.files });
    v.checklist.forEach((text, i) => items.push({ id: `${u.id}.${i + 1}`, kind: 'viewpoint', lens: 'spec', source: v.id, region, highRisk: !!u.mandatory, mandatory: !!u.mandatory, text: `${v.title}: ${text}` }));
  }
  for (const u of input.units.filter((x) => x.kind === 'S')) {
    regions.push({ id: `R-${u.id}`, hunkIds: u.hunkIds, files: u.files, usages: (u.usages ?? []).map((x) => ({ file: x.file, line: x.line, text: x.text })) });
    items.push({ id: `${u.id}.callers`, kind: 'seam', lens: 'spec', source: u.id, region: `R-${u.id}`, highRisk: false, mandatory: false, text: `Callers of the symbols changed in ${u.files[0]} still hold: arguments, return values, nullability, exceptions and side effects they rely on.` });
  }
  return { items, regions: regions.filter((r) => items.some((i) => i.region === r.id)) };
}

/** Batches by (region, lens), split only when a region has more than `maxItems` items. */
export function planBatches(items: AuditItem[], maxItems: number): AuditBatch[] {
  const groups = new Map<string, AuditItem[]>();
  for (const i of items) {
    const key = `${i.region}|${i.lens}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const batches: AuditBatch[] = [];
  for (const [key, list] of groups) {
    const [region, lens] = key.split('|') as [string, Lens];
    for (let i = 0; i < list.length; i += maxItems) {
      batches.push({ id: `${region.slice(2)}-${lens}${list.length > maxItems ? `-${i / maxItems + 1}` : ''}`, region, lens, itemIds: list.slice(i, i + maxItems).map((x) => x.id) });
    }
  }
  return batches;
}

/** The catalog of every item in the run: identical text in every call, so it belongs to the shared prefix. */
export function itemCatalog(items: AuditItem[]): string {
  return items.map((i) => `- ${i.id} [${i.kind}]: ${i.text}`).join('\n');
}

// ---- Answers -----------------------------------------------------------------------------------

/** Items of the batch the answer did not cover, and answers for items outside it (ignored). */
export function coverage(batchIds: string[], answers: AuditAnswer[]): { missing: string[]; extra: string[] } {
  const got = new Set(answers.map((a) => a.item_id));
  return { missing: batchIds.filter((id) => !got.has(id)), extra: [...got].filter((id) => !batchIds.includes(id)) };
}

export function newOutcome(itemId: string): ItemOutcome {
  return { itemId, status: 'not_run', evidence: [], rationale: '', missingContext: [], crossService: 'none', requirementIssue: null, history: [], routedFor: [], notes: [] };
}

/**
 * Applies a checked answer to an item. Citations that do not match the code are dropped; a
 * `fail` whose cause cannot be found in the code is not a finding and the item becomes
 * `cannot_determine` (missing evidence is never turned into a pass, nor into a defect).
 */
export function applyAnswer(
  o: ItemOutcome,
  a: AuditAnswer,
  pass: string,
  verify: (c: Citation) => boolean,
): { outcome: ItemOutcome; candidate: (RawCandidate & { citationOk: boolean }) | null } {
  const evidence = a.evidence.filter(verify);
  const dropped = a.evidence.length - evidence.length;
  const notes = [...o.notes];
  if (dropped) notes.push(`${pass}: ${dropped} citation(s) did not match the code and were dropped`);
  let status: ItemStatus = a.verdict;
  let candidate: (RawCandidate & { citationOk: boolean }) | null = null;
  if (a.verdict === 'fail') {
    if (!a.candidate) {
      status = 'cannot_determine';
      notes.push(`${pass}: verdict fail without a described defect`);
    } else {
      const ok = verify(a.candidate.cause);
      candidate = { ...a.candidate, citationOk: ok };
      if (!ok) {
        status = 'cannot_determine';
        notes.push(`${pass}: cited cause ${a.candidate.cause.file}:${a.candidate.cause.line} not found in the code`);
      }
    }
  }
  return {
    outcome: {
      ...o,
      status,
      evidence,
      rationale: a.rationale,
      missingContext: a.missing_context,
      crossService: a.cross_service,
      requirementIssue: a.requirement_issue ?? o.requirementIssue,
      history: [...o.history, `${pass}:${a.verdict}${status !== a.verdict ? `→${status}` : ''}`],
      notes,
    },
    candidate,
  };
}

// ---- Routing -----------------------------------------------------------------------------------

export interface RoutePolicy {
  arm: ReviewArm;
  /** Fraction of pass / not_applicable items re-read independently (arm C). */
  auditSampleRate: number;
  /** Independent second read of high-risk items (arm C). */
  secondReadHighRisk: boolean;
}

/**
 * Who gets more work after the first pass. Arm B only verifies candidates; `cannot_determine`
 * stays visible as "not checked". Arm C also opens an investigation when the auditor lacked a
 * contract or owner, when cross-service impact is unknown, for high-risk items, and for a
 * deterministic sample of "no problem found" — absence of evidence is not a pass.
 */
export function routeItems(items: AuditItem[], outcomes: Map<string, ItemOutcome>, hasCandidate: (itemId: string) => boolean, policy: RoutePolicy, seed: string): Map<string, RouteReason[]> {
  const routes = new Map<string, RouteReason[]>();
  const add = (id: string, r: RouteReason) => routes.set(id, [...(routes.get(id) ?? []), r]);
  for (const item of items) {
    const o = outcomes.get(item.id);
    if (!o) continue;
    if (hasCandidate(item.id)) add(item.id, 'candidate');
    if (policy.arm !== 'C') continue;
    if (o.status === 'cannot_determine' || o.missingContext.length) add(item.id, 'missing_context');
    if (o.crossService === 'unknown') add(item.id, 'cross_service_unknown');
    if (policy.secondReadHighRisk && item.highRisk && (o.status === 'pass' || o.status === 'not_applicable') && !routes.has(item.id)) add(item.id, 'high_risk');
  }
  if (policy.arm === 'C' && policy.auditSampleRate > 0) {
    const quiet = items.filter((i) => {
      const s = outcomes.get(i.id)?.status;
      return (s === 'pass' || s === 'not_applicable') && !routes.has(i.id);
    });
    const n = quiet.length ? Math.max(1, Math.round(quiet.length * policy.auditSampleRate)) : 0;
    // Passes without any evidence first, then a seeded order: reproducible for the same run.
    const order = (i: AuditItem) => `${outcomes.get(i.id)!.evidence.length ? 1 : 0}${sha256Hex(`${seed}:${i.id}`)}`;
    for (const i of [...quiet].sort((a, b) => order(a).localeCompare(order(b))).slice(0, n)) add(i.id, 'audit_sample');
  }
  return routes;
}

// ---- Root cause --------------------------------------------------------------------------------

export interface CandidateGroup {
  id: string;
  /** cause file + enclosing symbol: one defect can break several items and show in several places. */
  key: string;
  title: string;
  severity: Severity;
  class: CandidateClass;
  category: string;
  invariant: string;
  entryPoints: string[];
  cause: Citation;
  failingScenario: string;
  members: string[];
  items: string[];
  locations: Citation[];
}

const SEV: Record<Severity, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const CLASS_RANK: Record<CandidateClass, number> = { business: 0, technical: 1, convention: 2 };
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Nearest declaration at or above `line`: the method or class the cause sits in. */
export function enclosingSymbol(workspace: string, file: string, line: number): string {
  const abs = join(workspace, file);
  if (!existsSync(abs)) return '?';
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const decl = [
    /\b(?:public|protected|private|static|final|abstract|synchronized|default)\s+[\w<>[\], ?.]+\s+([a-zA-Z_]\w*)\s*\(/,
    /\b(?:class|interface|enum|record)\s+([A-Z]\w*)/,
    /\b(?:function|def)\s+([A-Za-z_]\w*)\s*\(/,
    /\b(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(/,
  ];
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    for (const re of decl) {
      const m = re.exec(lines[i]!);
      if (m) return m[1]!;
    }
  }
  return '<top>';
}

/**
 * Groups candidates by violated invariant + execution path + cause instead of (item, file,
 * line): the same root cause reported against two checklist items, or seen at two call sites,
 * becomes one finding with every location kept as evidence.
 */
export function groupByRootCause(candidates: Candidate[], symbolOf: (c: Citation) => string, threshold = 0.3): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  const sorted = [...candidates].filter((c) => c.citationOk).sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.id.localeCompare(b.id, 'en', { numeric: true }));
  for (const c of sorted) {
    const key = `${c.cause.file}#${symbolOf(c.cause)}`;
    const same = groups.find((g) => g.key === key && (g.items.includes(c.itemId) || similarity(`${g.invariant} ${g.title}`, `${c.invariant} ${c.title}`) >= threshold));
    if (same) {
      same.members.push(c.id);
      if (!same.items.includes(c.itemId)) same.items.push(c.itemId);
      if (c.entry_point && !same.entryPoints.includes(c.entry_point)) same.entryPoints.push(c.entry_point);
      for (const loc of [c.cause, ...c.evidence]) if (!same.locations.some((l) => l.file === loc.file && l.line === loc.line)) same.locations.push(loc);
      if (CLASS_RANK[c.class] < CLASS_RANK[same.class]) same.class = c.class;
      continue;
    }
    groups.push({
      id: `G${groups.length + 1}`,
      key,
      title: c.title,
      severity: c.severity,
      class: c.class,
      category: c.category,
      invariant: c.invariant,
      entryPoints: c.entry_point ? [c.entry_point] : [],
      cause: c.cause,
      failingScenario: c.failing_scenario,
      members: [c.id],
      items: [c.itemId],
      locations: [c.cause, ...c.evidence.filter((e) => !(e.file === c.cause.file && e.line === c.cause.line))],
    });
  }
  return groups;
}

/** Maps an agentic reviewer finding (arm A) onto the candidate shape so all arms share verification. */
export function classify(category: string, unitKind: string): CandidateClass {
  if (unitKind === 'B') return 'business';
  return /(style|naming|convention|clean|readab|maintainab|format|doc|duplicat|dead code)/i.test(category) ? 'convention' : 'technical';
}

/** Hunks of a region (helper for packs and prompts). */
export function regionHunks(region: Region, hunks: Map<string, Hunk>): Hunk[] {
  return region.hunkIds.map((id) => hunks.get(id)).filter((h): h is Hunk => !!h);
}
