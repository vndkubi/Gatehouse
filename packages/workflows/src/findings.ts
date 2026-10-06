import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export type Severity = 'P1' | 'P2' | 'P3' | 'P4';

/** What the reviewer agent reported (validated against the output schema). */
export interface RawFinding {
  title: string;
  severity: Severity;
  category: string;
  file: string;
  line: number;
  evidence_quote: string;
  explanation: string;
  failing_scenario: string;
  suggested_fix: string;
  repro: { test_class: string; test_source: string } | null;
}

/**
 * Evidence is decided by trusted code only:
 *  CITED            file:line exists at head and the quote matches nearby
 *  NO_EVIDENCE      citation did not verify
 *  REPRO_RED        repro test fails on head and passes on the merge base (introduced by the PR)
 *  REPRO_RED_BOTH   fails on both: pre-existing issue or a wrong test; weaker than REPRO_RED
 *  REPRO_GREEN      the reviewer's own repro passes on head: evidence against the claim
 *  REPRO_INCONCLUSIVE  the test did not compile or run
 */
export type Evidence = 'CITED' | 'NO_EVIDENCE' | 'REPRO_RED' | 'REPRO_RED_BOTH' | 'REPRO_GREEN' | 'REPRO_INCONCLUSIVE';

/** Final standing after the challenge. Arguments alone never move a finding (invariant I11). */
export type Verdict = 'STANDS' | 'UNCHALLENGED' | 'DISPUTED' | 'WITHDRAWN' | 'REJECTED';

export interface Finding extends RawFinding {
  id: string;
  unit: string;
  evidence: Evidence;
  verdict: Verdict;
  /** Line sits inside the diff, so it can carry an inline GitHub comment. */
  inDiff: boolean;
  notes: string[];
  mergedFrom?: string[];
}

export interface CriticVerdict {
  finding_id: string;
  agree: boolean;
  reasoning: string;
  counter_evidence: { file: string; line: number; quote: string } | null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Verifies `file:line` + quote against the workspace at head. Never trusts the agent's word. */
export function verifyCitation(workspace: string, file: string, line: number, quote: string): { ok: boolean; reason?: string } {
  const abs = resolve(workspace, file);
  if (!abs.startsWith(resolve(workspace) + sep)) return { ok: false, reason: 'path escapes the workspace' };
  if (!existsSync(abs)) return { ok: false, reason: `${file} does not exist at head` };
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return { ok: false, reason: `${file} has no line ${line}` };
  const q = norm(quote);
  if (q.length < 3) return { ok: false, reason: 'quote too short to verify' };
  const window = lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + 3)).map(norm);
  const joined = window.join(' ');
  return window.some((l) => l.includes(q)) || joined.includes(q) ? { ok: true } : { ok: false, reason: `quote not found near ${file}:${line}` };
}

const SEVERITY_RANK: Record<Severity, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const EVIDENCE_RANK: Record<Evidence, number> = { REPRO_RED: 0, REPRO_RED_BOTH: 1, CITED: 2, REPRO_INCONCLUSIVE: 3, REPRO_GREEN: 4, NO_EVIDENCE: 5 };

/**
 * The challenge state machine (design 03 §3.2). The critic's opinion is input; the outcome is
 * computed here. A failing test outranks any argument; a verified counter-citation can only
 * move a finding to DISPUTED (a human decides); a repro that passes is evidence against.
 */
export function applyChallenge(f: Finding, verdict: CriticVerdict | undefined, counterVerified: boolean): Finding {
  if (f.evidence === 'NO_EVIDENCE') return { ...f, verdict: 'REJECTED' };
  if (!verdict) return { ...f, verdict: 'UNCHALLENGED' };
  const notes = [...f.notes];
  if (verdict.agree) {
    if (f.evidence === 'REPRO_GREEN') {
      notes.push('Critic agrees, but the reviewer\'s own repro test passes on head.');
      return { ...f, verdict: 'DISPUTED', notes };
    }
    return { ...f, verdict: 'STANDS', notes };
  }
  notes.push(`Critic disagrees: ${verdict.reasoning}`);
  if (f.evidence === 'REPRO_RED' || f.evidence === 'REPRO_RED_BOTH') {
    notes.push('Kept: a failing repro test outranks an argument.');
    return { ...f, verdict: 'STANDS', notes };
  }
  if (f.evidence === 'REPRO_GREEN') return { ...f, verdict: 'WITHDRAWN', notes };
  if (counterVerified) {
    notes.push(`Counter-evidence verified at ${verdict.counter_evidence!.file}:${verdict.counter_evidence!.line}.`);
    return { ...f, verdict: 'DISPUTED', notes };
  }
  notes.push('Kept: the dissent cited no verifiable counter-evidence.');
  return { ...f, verdict: 'STANDS', notes };
}

/** Same file, within 2 lines, same category: keep the strongest, remember the others. */
export function dedupe(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence] || a.id.localeCompare(b.id),
  );
  const kept: Finding[] = [];
  for (const f of sorted) {
    const dup = kept.find((k) => k.file === f.file && k.category === f.category && Math.abs(k.line - f.line) <= 2);
    if (dup) dup.mergedFrom = [...(dup.mergedFrom ?? []), f.id];
    else kept.push({ ...f });
  }
  return kept.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

export const postable = (f: Finding) => f.verdict === 'STANDS' || f.verdict === 'UNCHALLENGED';
