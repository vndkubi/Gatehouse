import { readFileSync } from 'node:fs';
import { canRunWorkflow } from '@gatehouse/core';
import { awaitGate } from '@gatehouse/gates';
import { runPrReview, runTicket, type TicketPackage } from '@gatehouse/workflows';
import { envFor, gateOutcome, mustRepo, ticketFetcher, type JobOutcome, type Log, repoTarget } from './jobs.ts';
import { adapters, envApprovedFor, routesFor, runIdFor, startGateway, type Runtime } from './runtime.ts';

export interface TicketStart {
  workflow: 'ticket';
  repo: string;
  ticketKey: string;
  ticketArtifact?: string;
}

export function ticketStart(rt: Runtime, o: { repo: string; ticket: string; ticketFile?: string }): TicketStart {
  mustRepo(rt, o.repo);
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(o.ticket)) throw new Error(`invalid ticket key ${o.ticket}`);
  const start: TicketStart = { workflow: 'ticket', repo: o.repo, ticketKey: o.ticket.toUpperCase() };
  if (o.ticketFile) start.ticketArtifact = rt.artifacts.put('ticket.source', readFileSync(o.ticketFile, 'utf8'), 'text/markdown', { ticket: start.ticketKey }).hash;
  return start;
}

/** Runs (or resumes) the ticket pipeline until it finishes or stops at a gate / blocking question. */
export async function ticketJob(rt: Runtime, start: TicketStart, log: Log, runId?: string): Promise<JobOutcome<TicketPackage>> {
  const id = runId ?? runIdFor('tkt', start.repo, start.ticketKey);
  const repo = mustRepo(rt, start.repo);
  const decision = canRunWorkflow({ workflow: 'ticket', repo: repo.name, pciScope: repo.pciScope, routes: routesFor(rt, true) });
  if (!decision.allow) {
    rt.events.append(id, 'POLICY_DENIED', { reasons: decision.reasons });
    return { runId: id, status: 'denied', message: decision.reasons.join('\n') };
  }
  const resuming = !!runId && rt.events.list(runId).some((e) => e.type === 'RUN_STARTED');
  rt.events.append(id, resuming ? 'RUN_RESUMED' : 'RUN_STARTED', resuming ? {} : start);
  const { gateway, url } = await startGateway(rt);
  const { copilot, codex } = adapters(rt, url);
  const tickets = await ticketFetcher(rt, id);
  const target = repoTarget(rt, repo.name);
  try {
    if (!copilot) throw new Error('Copilot executor is disabled; the ticket pipeline needs it');
    const pkg = await runTicket(
      {
        config: rt.config,
        events: rt.events,
        artifacts: rt.artifacts,
        repo,
        target,
        runsDir: rt.paths.runs,
        author: copilot,
        critic: codex,
        env: await envFor(rt, repo.name),
        awaitGate: (gate, artifact) => awaitGate(rt.events, rt.approvers, rt.web, id, gate, artifact),
        fetchTicket: tickets?.fetch,
        review: async ({ base, head, title, body }) => {
          const child = `${id}--review`;
          rt.events.append(child, 'RUN_STARTED', { workflow: 'pr-review', repo: repo.name, parent: id, embedded: true });
          rt.events.append(id, 'CHILD_RUN', { runId: child, workflow: 'pr-review' });
          const r = await runPrReview(
            {
              config: rt.config,
              events: rt.events,
              artifacts: rt.artifacts,
              repo,
              target,
              runsDir: rt.paths.runs,
              github: null,
              reviewer: copilot,
              critic: codex,
              usage: () => gateway.usageFor(id),
              envApproved: envApprovedFor(rt),
              log,
            },
            { runId: child, source: { kind: 'refs', base, head, title, body, label: `${start.ticketKey} implementation` }, embedded: true },
          );
          return { packageHash: r.packageHash, summaryPath: r.summaryPath, postable: r.postable };
        },
        log,
      },
      { runId: id, ticketKey: start.ticketKey, ticketArtifact: start.ticketArtifact },
    );
    rt.events.append(id, 'RUN_USAGE', gateway.usageFor(id));
    return { runId: id, status: 'awaiting-gate', message: `Implementation ready on ${pkg.branch}; approve GATE_5 to push it and open a draft PR.`, result: pkg };
  } catch (err) {
    rt.events.append(id, 'RUN_USAGE', gateway.usageFor(id));
    return gateOutcome(id, err) as JobOutcome<TicketPackage>;
  } finally {
    await tickets?.close();
    await gateway.stop();
  }
}
