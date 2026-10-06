import type { ArtifactStore, EventStore } from '@gatehouse/core';
import { GitHubError, type GitHubClient, type ReviewComment } from '@gatehouse/github';
import { MARKER, findingMarkdown, postable, type ReviewPackage } from '@gatehouse/workflows';
import type { ApproverStore } from '@gatehouse/gates';
import { verifyDecision, type WebAuthnOrigin } from '@gatehouse/gates';

export type PublishOutcome =
  | { status: 'published'; reviewId: number; url: string }
  | { status: 'already-published' }
  | { status: 'rejected-by-human' }
  | { status: 'refused'; reason: string };

/**
 * The only code path that writes to GitHub. It re-verifies the human's signed decision and the
 * package hash itself rather than trusting whoever called it, and is idempotent through a
 * marker in the review body.
 */
export async function publishReview(deps: {
  events: EventStore;
  artifacts: ArtifactStore;
  approvers: ApproverStore;
  github: GitHubClient;
  web: WebAuthnOrigin;
  runId: string;
}): Promise<PublishOutcome> {
  const { events, runId } = deps;
  const check = await verifyDecision(events, deps.approvers, runId, deps.web);
  if (!check.ok) {
    events.append(runId, 'PUBLISH_REFUSED', { reason: check.reason });
    return { status: 'refused', reason: check.reason };
  }
  if (check.decision.decision !== 'approve') return { status: 'rejected-by-human' };

  // ArtifactStore.read re-hashes the blob, so a tampered package cannot be published.
  const pkg = JSON.parse(deps.artifacts.read(check.decision.artifact).toString('utf8')) as ReviewPackage;
  if (!pkg.pr) return { status: 'refused', reason: 'this review has no pull request to post to' };
  const { owner, repo, number } = pkg.pr;
  const marker = MARKER(runId);
  const existing = await deps.github.listReviews(owner, repo, number);
  if (existing.some((r) => r.body.includes(marker))) {
    events.append(runId, 'PUBLISH_SKIPPED', { reason: 'already published' });
    return { status: 'already-published' };
  }

  const keep = pkg.findings.filter(postable);
  const inline = keep.filter((f) => f.inDiff);
  const comments: ReviewComment[] = inline.map((f) => ({ path: f.file, line: f.line, side: 'RIGHT', body: findingMarkdown(f, false) }));
  const body = reviewBody(pkg, keep.filter((f) => !f.inDiff), marker);
  try {
    const r = await deps.github.createReview(owner, repo, number, { commitId: pkg.head, body, comments });
    events.append(runId, 'PUBLISHED', { reviewId: r.id, url: r.url, inline: comments.length, total: keep.length, approver: check.decision.credentialId.slice(0, 12) });
    return { status: 'published', reviewId: r.id, url: r.url };
  } catch (err) {
    // GitHub rejects inline comments on lines it does not consider part of the diff; fall back to one body.
    if (err instanceof GitHubError && err.status === 422 && comments.length) {
      const r = await deps.github.createReview(owner, repo, number, { commitId: pkg.head, body: reviewBody(pkg, keep, marker), comments: [] });
      events.append(runId, 'PUBLISHED', { reviewId: r.id, url: r.url, inline: 0, total: keep.length, note: 'inline comments rejected by GitHub; posted in body' });
      return { status: 'published', reviewId: r.id, url: r.url };
    }
    events.append(runId, 'PUBLISH_FAILED', { error: (err as Error).message.slice(0, 300) });
    throw err;
  }
}

function reviewBody(pkg: ReviewPackage, notInline: ReviewPackage['findings'], marker: string): string {
  const keep = pkg.findings.filter(postable);
  const disputed = pkg.findings.filter((f) => f.verdict === 'DISPUTED');
  const lines = [
    `**Gatehouse review** — ${keep.length} finding(s); ${pkg.ledger.reviewedHunks}/${pkg.ledger.totalHunks} hunks reviewed; environment ${pkg.envLevel}; critic: ${pkg.critic}.`,
    'Every finding cites a verified line; "proven" ones failed a repro test on this PR and passed on the base. Approved by a human before posting.',
  ];
  if (notInline.length) {
    lines.push('', '### Findings outside the diff');
    for (const f of notInline) lines.push('', findingMarkdown(f, false));
  }
  if (disputed.length) {
    lines.push('', '### Disputed (reviewers disagree; please judge)');
    for (const f of disputed) lines.push('', findingMarkdown(f, true));
  }
  if (pkg.ledger.missing.length) lines.push('', `Not reviewed: ${pkg.ledger.missing.join(', ')}.`);
  lines.push('', marker);
  return lines.join('\n');
}
