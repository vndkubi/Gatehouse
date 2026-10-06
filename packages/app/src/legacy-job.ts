import { canRunWorkflow } from '@gatehouse/core';
import { awaitGate } from '@gatehouse/gates';
import { runLegacyTests, type LegacyPackage } from '@gatehouse/workflows';
import { envFor, gateOutcome, mustRepo, type JobOutcome, type Log, repoTarget } from './jobs.ts';
import { adapters, routesFor, runIdFor, startGateway, type Runtime } from './runtime.ts';

export interface LegacyStart {
  workflow: 'legacy-tests';
  repo: string;
  scope?: string;
  maxTargets?: number;
}

export async function legacyJob(rt: Runtime, start: LegacyStart, log: Log, runId?: string): Promise<JobOutcome<LegacyPackage>> {
  const id = runId ?? runIdFor('lgt', start.repo);
  const repo = mustRepo(rt, start.repo);
  const decision = canRunWorkflow({ workflow: 'legacy-tests', repo: repo.name, pciScope: repo.pciScope, routes: routesFor(rt, true) });
  if (!decision.allow) {
    rt.events.append(id, 'POLICY_DENIED', { reasons: decision.reasons });
    return { runId: id, status: 'denied', message: decision.reasons.join('\n') };
  }
  const resuming = !!runId && rt.events.list(runId).some((e) => e.type === 'RUN_STARTED');
  rt.events.append(id, resuming ? 'RUN_RESUMED' : 'RUN_STARTED', resuming ? {} : start);
  const { gateway, url } = await startGateway(rt);
  const { copilot, codex } = adapters(rt, url);
  try {
    if (!copilot) throw new Error('Copilot executor is disabled; the legacy test pipeline needs it');
    const pkg = await runLegacyTests(
      {
        config: rt.config,
        events: rt.events,
        artifacts: rt.artifacts,
        repo,
        target: repoTarget(rt, repo.name),
        runsDir: rt.paths.runs,
        author: copilot,
        critic: codex,
        env: await envFor(rt, repo.name),
        awaitGate: (gate, artifact) => awaitGate(rt.events, rt.approvers, rt.web, id, gate, artifact),
        log,
      },
      { runId: id, scope: start.scope, maxTargets: start.maxTargets },
    );
    rt.events.append(id, 'RUN_USAGE', gateway.usageFor(id));
    return { runId: id, status: 'awaiting-gate', message: `Tests ready on ${pkg.branch}; approve GATE_4 to push them and open a draft PR.`, result: pkg };
  } catch (err) {
    rt.events.append(id, 'RUN_USAGE', gateway.usageFor(id));
    return gateOutcome(id, err) as JobOutcome<LegacyPackage>;
  } finally {
    await gateway.stop();
  }
}
