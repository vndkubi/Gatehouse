import { postable, type Finding } from './findings.ts';
import type { ReviewPackage } from './package.ts';

export const EVIDENCE_LABEL: Record<Finding['evidence'], string> = {
  REPRO_RED: 'proven: repro test fails on the PR and passes on base',
  REPRO_RED_BOTH: 'repro test fails on both base and PR (pre-existing, or the test is wrong)',
  REPRO_GREEN: 'repro test passes on the PR (claim not demonstrated)',
  REPRO_INCONCLUSIVE: 'repro test did not run',
  CITED: 'inspected: citation verified, no runnable repro',
  NO_EVIDENCE: 'citation did not match the code',
};

const AC_ICON: Record<string, string> = { implemented: '✅', partial: '🟡', missing: '❌', unclear: '❔' };

export function findingMarkdown(f: Finding, withNotes = true): string {
  const lines = [
    `**[${f.severity}] ${f.title}** — \`${f.file}:${f.line}\` (${f.category})`,
    '',
    f.explanation,
    '',
    `- Failing scenario: ${f.failing_scenario}`,
    `- Suggested fix: ${f.suggested_fix}`,
    `- Evidence: ${EVIDENCE_LABEL[f.evidence]}`,
  ];
  if (withNotes) for (const n of f.notes) lines.push(`- Note: ${n}`);
  if (f.mergedFrom?.length) lines.push(`- Also reported as ${f.mergedFrom.join(', ')}`);
  return lines.join('\n');
}

function titleOf(pkg: ReviewPackage): string {
  return pkg.pr ? `${pkg.pr.owner}/${pkg.pr.repo}#${pkg.pr.number}: ${pkg.pr.title}` : pkg.source.label;
}

function unitCounts(pkg: ReviewPackage): string {
  const n = (k: string) => pkg.units.filter((u) => u.kind === k).length;
  const v = pkg.units.filter((u) => u.kind === 'V').map((u) => u.viewpoint).join(', ');
  return `${n('T')} technical, ${n('B')} business, ${n('V')} viewpoint${v ? ` (${v})` : ''}, ${n('S')} seam`;
}

export function renderSummary(pkg: ReviewPackage): string {
  const keep = pkg.findings.filter(postable);
  const disputed = pkg.findings.filter((f) => f.verdict === 'DISPUTED');
  const dropped = pkg.findings.filter((f) => f.verdict === 'WITHDRAWN' || f.verdict === 'REJECTED');
  const count = (sev: string) => keep.filter((f) => f.severity === sev).length;
  const out = [
    `# Gatehouse review — ${titleOf(pkg)}`,
    '',
    `Head \`${pkg.head.slice(0, 10)}\` · merge base \`${pkg.mergeBase.slice(0, 10)}\` · run \`${pkg.runId}\` · env ${pkg.envLevel} · critic: ${pkg.critic}`,
    '',
  ];
  if (pkg.incomplete) out.push(`**⚠ Incomplete review (fail-closed):** ${pkg.incompleteReasons.join('; ')}.`, '');
  out.push(
    `**${keep.length} finding(s)** (P1 ${count('P1')} · P2 ${count('P2')} · P3 ${count('P3')} · P4 ${count('P4')}), ${disputed.length} disputed, ${dropped.length} withdrawn/rejected.`,
    `Units: ${unitCounts(pkg)}. Coverage: ${pkg.ledger.reviewedHunks}/${pkg.ledger.totalHunks} hunks.`,
    `Model usage: ${pkg.usage.calls} gateway calls, ${pkg.usage.promptTokens + pkg.usage.completionTokens} tokens${pkg.usage.costUsd === null ? ' (cost unknown: no pricing configured)' : `, $${pkg.usage.costUsd.toFixed(4)}`}.`,
    '',
    pkg.pr ? 'Status: **awaiting GATE_5** — approve in the Gatehouse console to post this review.' : 'Local review: nothing is posted anywhere.',
    '',
  );
  if (pkg.warnings.length) out.push('## Warnings', ...pkg.warnings.map((w) => `- ${w}`), '');
  if (pkg.acStatus.length) {
    out.push('## Acceptance criteria', '');
    const text = new Map((pkg.requirements?.acceptance_criteria ?? []).map((a) => [a.id, a.text]));
    for (const a of pkg.acStatus) out.push(`- ${AC_ICON[a.status] ?? ''} **${a.ac_id}** ${a.status} — ${text.get(a.ac_id) ?? ''}${a.note ? ` _(${a.note})_` : ''}`);
    out.push('');
  }
  out.push('## Findings to post', '');
  if (!keep.length) out.push('_None._', '');
  for (const f of keep) out.push(`### ${f.id}`, findingMarkdown(f), '');
  if (disputed.length) {
    out.push('## Disputed — needs your judgement (not posted inline)', '');
    for (const f of disputed) out.push(`### ${f.id}`, findingMarkdown(f), '');
  }
  if (dropped.length) {
    out.push('## Withdrawn or rejected (not posted)', '');
    for (const f of dropped) out.push(`- ${f.id} [${f.severity}] ${f.title} — \`${f.file}:${f.line}\`: ${f.verdict}${f.notes.length ? ` (${f.notes.at(-1)})` : ''}`);
    out.push('');
  }
  if (pkg.blast.dependentFiles.length || pkg.blast.testsAtRisk.length) {
    out.push('## Blast radius (code outside the diff that uses what changed)', '');
    if (pkg.blast.dependentFiles.length) out.push(`- Dependent files: ${pkg.blast.dependentFiles.slice(0, 20).map((f) => `\`${f}\``).join(', ')}`);
    if (pkg.blast.testsAtRisk.length) out.push(`- Tests/fixtures at risk: ${pkg.blast.testsAtRisk.slice(0, 20).map((f) => `\`${f}\``).join(', ')}`);
    out.push('');
  }
  if (pkg.orphans.length) out.push('## Changes no acceptance criterion explains', '', `- Hunks ${pkg.orphans.join(', ')}: check they are intended.`, '');
  if (pkg.requirements) {
    out.push('## What the change says it does (read in quarantine)', '', pkg.requirements.summary, '');
    if (pkg.requirements.open_questions.length) out.push('**Open questions**', ...pkg.requirements.open_questions.map((q) => `- ${q}`), '');
  }
  if (pkg.masked.length) out.push('## Agent instruction files hidden from reviewers', ...pkg.masked.map((m) => `- \`${m}\``), '');
  if (pkg.unreviewable.length) out.push('## Not reviewable', ...pkg.unreviewable.map((m) => `- ${m}`), '');
  return out.join('\n');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const VERDICT_CLASS: Record<string, string> = { STANDS: 'ok', UNCHALLENGED: 'ok', DISPUTED: 'warn', WITHDRAWN: 'muted', REJECTED: 'muted' };

/** Self-contained HTML report (blueprint v1 code-review.html), safe to open from disk or attach. */
export function renderHtml(pkg: ReviewPackage): string {
  const e = escapeHtml;
  const rows = pkg.findings
    .map(
      (f) => `<tr class="${VERDICT_CLASS[f.verdict] ?? ''}"><td>${e(f.id)}</td><td><span class="sev ${f.severity}">${f.severity}</span></td><td><strong>${e(f.title)}</strong><div class="meta">${e(f.category)} · <code>${e(f.file)}:${f.line}</code> · unit ${e(f.unit)}</div>
<details><summary>Details</summary><p>${e(f.explanation)}</p><p><b>Scenario:</b> ${e(f.failing_scenario)}</p><p><b>Fix:</b> ${e(f.suggested_fix)}</p><pre>${e(f.evidence_quote)}</pre>${f.notes.map((n) => `<p class="note">${e(n)}</p>`).join('')}</details></td>
<td>${e(EVIDENCE_LABEL[f.evidence])}</td><td>${e(f.verdict)}</td></tr>`,
    )
    .join('');
  const acText = new Map((pkg.requirements?.acceptance_criteria ?? []).map((a) => [a.id, a.text]));
  const acs = pkg.acStatus.map((a) => `<tr><td>${e(a.ac_id)}</td><td>${AC_ICON[a.status] ?? ''} ${e(a.status)}</td><td>${e(acText.get(a.ac_id) ?? '')}</td><td>${e(a.note)}</td></tr>`).join('');
  const units = pkg.units.map((u) => `<tr><td>${e(u.id)}</td><td>${e(u.kind)}</td><td>${e(u.files.slice(0, 4).join(', '))}${u.files.length > 4 ? '…' : ''}</td><td>${u.hunkIds.length}</td><td>${pkg.ledger.incompleteUnits.includes(u.id) ? 'incomplete' : 'done'}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gatehouse review · ${e(titleOf(pkg))}</title>
<style>
:root{--bg:#fafaf8;--fg:#1c1c1a;--muted:#6b6b66;--line:#ddd;--card:#fff;--ok:#2f6b3a;--warn:#8a5a00;--bad:#9b2c2c}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--muted:#9a9a93;--line:#33332f;--card:#1f1f1d;--ok:#7cc48a;--warn:#e0b04c;--bad:#ef8f8f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:21px}h2{font-size:16px;margin-top:28px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted)}code,pre{font-family:ui-monospace,Consolas,monospace;font-size:13px}pre{white-space:pre-wrap;background:var(--bg);padding:6px}.meta,.note{color:var(--muted);font-size:13px}
tr.muted{opacity:.55}.sev{padding:0 6px;border-radius:4px;border:1px solid currentColor;font-size:12px}.P1{color:var(--bad)}.P2{color:var(--warn)}.banner{border:1px solid var(--warn);color:var(--warn);padding:8px 12px;border-radius:6px}
</style></head><body><main>
<h1>${e(titleOf(pkg))}</h1>
<p class="meta">Head <code>${e(pkg.head.slice(0, 10))}</code> · merge base <code>${e(pkg.mergeBase.slice(0, 10))}</code> · env ${e(pkg.envLevel)} · critic ${e(pkg.critic)} · ${pkg.ledger.reviewedHunks}/${pkg.ledger.totalHunks} hunks · ${pkg.usage.promptTokens + pkg.usage.completionTokens} tokens</p>
${pkg.incomplete ? `<p class="banner">Incomplete review: ${e(pkg.incompleteReasons.join('; '))}</p>` : ''}
${pkg.warnings.map((w) => `<p class="meta">⚠ ${e(w)}</p>`).join('')}
<h2>Findings</h2>${rows ? `<table><thead><tr><th>ID</th><th>Sev</th><th>Finding</th><th>Evidence</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No findings.</p>'}
${acs ? `<h2>Acceptance criteria</h2><table><thead><tr><th>AC</th><th>Status</th><th>Criterion</th><th>Note</th></tr></thead><tbody>${acs}</tbody></table>` : ''}
${pkg.orphans.length ? `<h2>Changes no criterion explains</h2><p>${e(pkg.orphans.join(', '))}</p>` : ''}
${pkg.blast.dependentFiles.length || pkg.blast.testsAtRisk.length ? `<h2>Blast radius</h2><p class="meta">Dependent: ${e(pkg.blast.dependentFiles.join(', ') || 'none')}</p><p class="meta">Tests at risk: ${e(pkg.blast.testsAtRisk.join(', ') || 'none')}</p>` : ''}
<h2>Review units</h2><table><thead><tr><th>Unit</th><th>Kind</th><th>Files</th><th>Hunks</th><th>Status</th></tr></thead><tbody>${units}</tbody></table>
${pkg.masked.length ? `<h2>Agent instruction files hidden from reviewers</h2><p class="meta">${e(pkg.masked.join(', '))}</p>` : ''}
<p class="meta">Run ${e(pkg.runId)} · generated by Gatehouse</p>
</main></body></html>`;
}
