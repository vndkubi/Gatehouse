import type { AuditSummary } from './audit-review.ts';
import type { Finding } from './findings.ts';
import type { ReviewUnit } from './plan.ts';

export interface AcStatus {
  ac_id: string;
  status: 'implemented' | 'partial' | 'missing' | 'unclear';
  evidence_hunks: string[];
  note: string;
}

export interface Requirements {
  summary: string;
  acceptance_criteria: Array<{ id: string; text: string }>;
  risks: string[];
  open_questions: string[];
}

/** The reviewed, immutable unit a human approves at GATE_5. Its hash is what gets signed. */
export interface ReviewPackage {
  version: 1;
  runId: string;
  repo: string;
  /** null for branch / local reviews: there is nothing to post to. */
  pr: { owner: string; repo: string; number: number; url: string; title: string; author: string } | null;
  source: { kind: 'pr' | 'refs'; label: string };
  base: string;
  head: string;
  mergeBase: string;
  envLevel: string;
  requirements: Requirements | null;
  units: ReviewUnit[];
  ledger: { totalHunks: number; reviewedHunks: number; missing: string[]; incompleteUnits: string[] };
  unreviewable: string[];
  /** B units: per acceptance criterion, is it implemented? */
  acStatus: AcStatus[];
  /** Hunks no acceptance criterion accounts for (only when requirements exist). */
  orphans: string[];
  blast: { symbols: number; dependentFiles: string[]; testsAtRisk: string[] };
  /** Fail-closed: a mandatory viewpoint or technical unit did not complete. */
  incomplete: boolean;
  incompleteReasons: string[];
  masked: string[];
  findings: Finding[];
  agents: Record<string, string>;
  usage: { calls: number; promptTokens: number; completionTokens: number; cachedPromptTokens?: number; costUsd: number | null };
  critic: 'codex' | 'none';
  warnings: string[];
  /** pr-review-audit runs only: per-item verdicts, investigations and verification outcomes. */
  audit?: AuditSummary;
}

export const MARKER = (runId: string) => `<!-- gatehouse:run=${runId} -->`;
