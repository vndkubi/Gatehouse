import type { BlastRadius, Usage } from './blast.ts';
import type { FileDiff, Hunk } from './diff.ts';
import type { Requirements } from './package.ts';
import { matchViewpoint, type Viewpoint } from './routing.ts';

/**
 * Review dimensions (blueprint v1 unit groups):
 *  T technical — every hunk, partitioned by file (the anti-leak ledger runs over these)
 *  B business  — acceptance criteria: is each one actually implemented?
 *  V viewpoint — cross-cutting concerns fired by risk routing (security, money, data, ...)
 *  S seam      — changed symbols used elsewhere: do callers still hold?
 */
export type UnitKind = 'T' | 'B' | 'V' | 'S';

export interface ReviewUnit {
  id: string;
  kind: UnitKind;
  hunkIds: string[];
  files: string[];
  lines: number;
  riskTags: string[];
  /** B: acceptance criteria ids under review. */
  acIds?: string[];
  /** V: viewpoint id and whether it is fail-closed. */
  viewpoint?: string;
  mandatory?: boolean;
  /** S: usage sites outside the diff. */
  usages?: Usage[];
}

const RISK_RULES: Array<[string, RegExp]> = [
  ['auth', /(auth|login|session|token|password|credential|permission|acl|oauth|jwt)/i],
  ['payment', /(payment|card|pan|billing|invoice|refund|charge|ledger|settlement)/i],
  ['crypto', /(crypt|cipher|hash|sign|keystore|tls|ssl)/i],
  ['migration', /(migration|flyway|liquibase|changelog|schema\.sql|db\/)/i],
  ['ci', /(^|\/)(\.github\/workflows|Jenkinsfile|\.gitlab-ci|Dockerfile|docker-compose)/i],
  ['dependency', /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i],
];

export function riskTags(file: string): string[] {
  return RISK_RULES.filter(([, re]) => re.test(file)).map(([tag]) => tag);
}

const hunkSize = (h: Hunk) => h.text.split('\n').length;

/**
 * Deterministic partition of every reviewable hunk into units of at most `maxLines`.
 * Files stay together when they fit; a large file is split by hunk. The union of all units
 * equals the set of hunks exactly (the anti-leak ledger checks this again after review).
 */
export function planUnits(files: FileDiff[], maxLines: number): ReviewUnit[] {
  const units: ReviewUnit[] = [];
  let current: ReviewUnit | null = null;
  const open = () => {
    current = { id: `T${units.length + 1}`, kind: 'T', hunkIds: [], files: [], lines: 0, riskTags: [] };
    units.push(current);
    return current;
  };
  for (const f of files) {
    if (f.binary || f.status === 'deleted' || !f.hunks.length) continue;
    const size = f.hunks.reduce((n, h) => n + hunkSize(h), 0);
    let unit: ReviewUnit = current && (current as ReviewUnit).lines + size <= maxLines ? current : open();
    for (const h of f.hunks) {
      if (unit.lines > 0 && unit.lines + hunkSize(h) > maxLines) unit = open();
      unit.hunkIds.push(h.id);
      unit.lines += hunkSize(h);
      if (!unit.files.includes(f.file)) unit.files.push(f.file);
      for (const t of riskTags(f.file)) if (!unit.riskTags.includes(t)) unit.riskTags.push(t);
    }
  }
  return units;
}

/** Hunks excluded from review (binary / deleted files) are reported, not silently dropped. */
export function unreviewable(files: FileDiff[]): string[] {
  return files.filter((f) => f.binary || f.status === 'deleted').map((f) => `${f.file} (${f.binary ? 'binary' : 'deleted'})`);
}

export interface PlanInput {
  files: FileDiff[];
  requirements: Requirements | null;
  viewpoints: Viewpoint[];
  blast: BlastRadius;
  maxLines: number;
  maxSeamUnits: number;
  maxAcPerUnit: number;
}

/** Deterministic plan across all four dimensions. T units alone cover every hunk exactly once. */
export function planReview(input: PlanInput): ReviewUnit[] {
  const units: ReviewUnit[] = planUnits(input.files, input.maxLines);
  const hunks = input.files.filter((f) => !f.binary && f.status !== 'deleted').flatMap((f) => f.hunks);
  const allIds = hunks.map((h) => h.id);
  const allFiles = [...new Set(hunks.map((h) => h.file))];

  const acs = input.requirements?.acceptance_criteria ?? [];
  for (let i = 0; i < acs.length; i += input.maxAcPerUnit) {
    const chunk = acs.slice(i, i + input.maxAcPerUnit);
    units.push({ id: `B${units.filter((u) => u.kind === 'B').length + 1}`, kind: 'B', hunkIds: allIds, files: allFiles, lines: 0, riskTags: [], acIds: chunk.map((a) => a.id) });
  }

  for (const v of input.viewpoints) {
    const matched = matchViewpoint(v, hunks);
    if (!matched.length) continue;
    const picked: Hunk[] = [];
    let lines = 0;
    for (const h of matched) {
      const size = hunkSize(h);
      if (picked.length && lines + size > input.maxLines * 2) break;
      picked.push(h);
      lines += size;
    }
    units.push({
      id: `V-${v.id}`,
      kind: 'V',
      hunkIds: picked.map((h) => h.id),
      files: [...new Set(picked.map((h) => h.file))],
      lines,
      riskTags: [v.id],
      viewpoint: v.id,
      mandatory: v.mandatory,
    });
  }

  const byFile = new Map<string, Usage[]>();
  for (const s of input.blast.symbols) byFile.set(s.definedIn, [...(byFile.get(s.definedIn) ?? []), ...s.usages]);
  const seamFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, input.maxSeamUnits);
  for (const [file, usages] of seamFiles) {
    const fileHunks = hunks.filter((h) => h.file === file);
    units.push({
      id: `S${units.filter((u) => u.kind === 'S').length + 1}`,
      kind: 'S',
      hunkIds: fileHunks.map((h) => h.id),
      files: [file, ...new Set(usages.map((u) => u.file))],
      lines: fileHunks.reduce((n, h) => n + hunkSize(h), 0),
      riskTags: [],
      usages: usages.slice(0, 40),
    });
  }
  return units;
}
