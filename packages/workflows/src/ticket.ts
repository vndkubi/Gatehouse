import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ArtifactStore, type EventStore, type GatehouseConfig, type RepoRecord } from '@gatehouse/core';
import { redact } from '@gatehouse/dlp';
import { StepRunner } from '@gatehouse/engine';
import { readSurefireReports, type EnvSpec, type VerifyReport } from '@gatehouse/env';
import type { ExecutorAdapter } from '@gatehouse/harness';
import { fetchMirror, git, maskAgentInstructions, resolveCommit, type ExecutionTarget, type Workspace } from '@gatehouse/targets';
import { StageBlocked, agentStage, gateStep, hideFromCommits, topoSort } from './pipeline.ts';
import { fill, loadAgent, untrusted } from './registry.ts';
import { tddCycle, type TaskLog } from './tdd.ts';
import {
  renderIssues,
  renderPbi,
  renderPlan,
  renderSpec,
  renderTasks,
  renderTraceability,
  unansweredBlocking,
  validatePbi,
  validatePlan,
  validateSpec,
  validateTasks,
  type ArtifactIssue,
  type PbiManifest,
  type Plan,
  type Spec,
  type Tasks,
} from './ticket-artifacts.ts';
import { bindSteps, loadWorkflow, stepDef, stepParam } from './workflow-def.ts';

export interface TicketDeps {
  config: GatehouseConfig;
  events: EventStore;
  artifacts: ArtifactStore;
  repo: RepoRecord;
  target: ExecutionTarget;
  runsDir: string;
  /** Writes artifacts and code (Copilot through the gateway). */
  author: ExecutorAdapter;
  /** Independent reviewer of the planning artifacts (Codex), or null. */
  critic: ExecutorAdapter | null;
  /** Approved, verified environment for the repo; implementation needs L2. */
  env: { level: string; spec: EnvSpec | null; approved: boolean; baseline: VerifyReport['baseline'] | null };
  awaitGate: (gate: string, artifact: string) => Promise<void>;
  fetchTicket?: (key: string) => Promise<string | null>;
  /** Runs the PR review workflow on base..head as a child run; returns the review package hash. */
  review: (o: { base: string; head: string; title: string; body: string }) => Promise<{ packageHash: string; summaryPath: string; postable: number }>;
  log?: (line: string) => void;
}

export interface TicketInput {
  runId: string;
  ticketKey: string;
  /** Ticket text supplied at start (from a file), stored as an artifact. */
  ticketArtifact?: string;
  keepWorkspaces?: boolean;
}

export interface TicketPackage {
  version: 1;
  runId: string;
  repo: string;
  ticket: string;
  title: string;
  base: string;
  head: string;
  branch: string;
  artifacts: Record<string, string>;
  tasks: TaskLog[];
  regressions: string[];
  stats: { files: number; insertions: number; deletions: number };
  review: { packageHash: string; postable: number };
  warnings: string[];
}

/**
 * Ticket -> PR (registry/workflows/ticket.yaml). Each planning stage is an agent proposal checked
 * by trusted validators and approved by a human at its gate; implementation is test-first with
 * Gatehouse running every test; the patch is reviewed like any PR and waits at GATE_5 for the
 * publisher, which pushes a gatehouse/* branch and opens a draft PR.
 */
export async function runTicket(deps: TicketDeps, input: TicketInput): Promise<TicketPackage> {
  const def = loadWorkflow('ticket');
  const log = deps.log ?? (() => undefined);
  const runner = new StepRunner(deps.events, input.runId, log);
  const runDir = join(deps.runsDir, input.runId);
  const timeoutMs = deps.config.review.stepTimeoutMinutes * 60_000;
  const dlp = { testPanAllowlist: deps.config.pci.testPanAllowlist };
  const read = <T>(hash: string) => JSON.parse(deps.artifacts.read(hash).toString('utf8')) as T;
  const text = (hash: string) => deps.artifacts.read(hash).toString('utf8');
  const feedback = (stage: string) => {
    const notes = deps.events.list(input.runId).filter((e) => e.type === 'REVIEWER_NOTE' && (e.payload as { stage: string }).stage === stage).map((e) => (e.payload as { note: string }).note);
    return notes.length ? `\n## Reviewer feedback from the previous attempt (from the human approver)\n${notes.map((n) => `- ${n}`).join('\n')}` : '';
  };

  let base = '';
  let packetHash = '';
  let pbiHash = '';
  let specHash = '';
  let planHash = '';
  let tasksHash = '';
  let reviewHash = '';
  let implResult!: { head: string; tasksLog: string; regressions: string[]; stats: TicketPackage['stats']; warnings: string[] };
  let reviewResult!: { packageHash: string; summaryPath: string; postable: number };
  let packageHash = '';
  let planWs: Workspace | null = null;

  const planningWorkspace = async () => {
    planWs ??= await deps.target.prepare({ runId: input.runId, repo: deps.repo.name, sha: base, slot: 'plan', reuse: true });
    maskAgentInstructions(planWs.dir, join(runDir, 'masked'));
    return planWs;
  };

  const steps = bindSteps<() => Promise<void>>(def, {
    intake: async () => {
      const r = await runner.step('intake', async () => {
        await fetchMirror(deps.repo.mirror).catch(() => undefined);
        const sha = await resolveCommit(deps.repo.mirror, deps.repo.defaultBranch);
        let raw = input.ticketArtifact ? text(input.ticketArtifact) : deps.fetchTicket ? await deps.fetchTicket(input.ticketKey) : null;
        if (!raw) throw new Error(`ticket ${input.ticketKey} could not be read; configure review.ticketTool (MCP) or pass --ticket-file`);
        raw = redact(raw, dlp).text;
        const clarifications = deps.events
          .list(input.runId)
          .filter((e) => e.type === 'CLARIFICATION')
          .map((e) => e.payload as { question: string; answer: string });
        const packet = [
          untrusted(`ticket:${input.ticketKey}`, raw),
          ...clarifications.map((c) => untrusted(`user-clarification:${c.question}`, `Answer to ${c.question}: ${redact(c.answer, dlp).text}`)),
        ].join('\n\n');
        return { base: sha, packet: deps.artifacts.put('ticket.packet', packet, 'text/markdown', { runId: input.runId, ticket: input.ticketKey }).hash };
      });
      base = r.base;
      packetHash = r.packet;
    },

    pbi: async () => {
      const spec = loadAgent(stepDef(def, 'pbi').agent!);
      pbiHash = await runner.step('pbi', async () => {
        const scratch = join(runDir, 'scratch', 'pbi');
        mkdirSync(scratch, { recursive: true });
        const packet = text(packetHash);
        writeFileSync(join(scratch, 'packet.md'), packet);
        const m = await agentStage<PbiManifest>({
          runner,
          agent: deps.author,
          spec,
          task: { runId: input.runId, stepId: 'pbi', instructions: fill(spec.prompt, { feedback: feedback('pbi') }), scope: 'none', cwd: scratch, stateDir: join(runDir, 'agents', 'pbi'), tier: stepDef(def, 'pbi').tier!, timeoutMs },
          validate: (out) => validatePbi(out, packet),
        });
        const answered = new Set(deps.events.list(input.runId).filter((e) => e.type === 'CLARIFICATION').map((e) => (e.payload as { question: string }).question));
        const blocking = unansweredBlocking(m, answered);
        const art = deps.artifacts.putJson('ticket.pbi', m, { runId: input.runId, packet: packetHash });
        if (blocking.length) {
          runner.emit('BLOCKING_QUESTIONS', { pbi: art.hash, questions: m.open_questions.filter((q) => q.blocking && !answered.has(q.id)) });
          throw new StageBlocked('pbi', blocking.map((b) => `answer with: gatehouse run answer ${input.runId} --q ${b.split(':')[0]} --answer "..." (${b})`));
        }
        deps.artifacts.put('ticket.pbi.md', renderPbi(m), 'text/markdown', { runId: input.runId, of: art.hash });
        return art.hash;
      });
    },

    'gate-1': () => gateStep(runner, 'gate-1', 'GATE_1', pbiHash, deps.awaitGate),

    spec: async () => {
      const agent = loadAgent(stepDef(def, 'spec').agent!);
      specHash = await runner.step('spec', async () => {
        const pbi = read<PbiManifest>(pbiHash);
        const ws = await planningWorkspace();
        const s = await agentStage<Spec>({
          runner,
          agent: deps.author,
          spec: agent,
          task: { runId: input.runId, stepId: 'spec', instructions: fill(agent.prompt, { pbi: untrusted('approved-pbi', renderPbi(pbi)), feedback: feedback('spec') }), scope: 'read-repo', cwd: ws.dir, stateDir: join(runDir, 'agents', 'spec'), tier: stepDef(def, 'spec').tier!, timeoutMs },
          validate: (out) => validateSpec(out, pbi, ws.dir),
        });
        return deps.artifacts.putJson('ticket.spec', s, { runId: input.runId, pbi: pbiHash }).hash;
      });
    },

    'gate-2': () => gateStep(runner, 'gate-2', 'GATE_2', specHash, deps.awaitGate),

    plan: async () => {
      const agent = loadAgent(stepDef(def, 'plan').agent!);
      planHash = await runner.step('plan', async () => {
        const pbi = read<PbiManifest>(pbiHash);
        const spec = read<Spec>(specHash);
        const ws = await planningWorkspace();
        const p = await agentStage<Plan>({
          runner,
          agent: deps.author,
          spec: agent,
          task: {
            runId: input.runId,
            stepId: 'plan',
            instructions: fill(agent.prompt, { pbi: untrusted('approved-pbi', renderPbi(pbi)), spec: untrusted('approved-spec', renderSpec(spec)), feedback: feedback('plan') }),
            scope: 'read-repo',
            cwd: ws.dir,
            stateDir: join(runDir, 'agents', 'plan'),
            tier: stepDef(def, 'plan').tier!,
            timeoutMs,
          },
          validate: (out) => validatePlan(out, spec, pbi, ws.dir),
        });
        return deps.artifacts.putJson('ticket.plan', p, { runId: input.runId, spec: specHash }).hash;
      });
    },

    'gate-3': () => gateStep(runner, 'gate-3', 'GATE_3', planHash, deps.awaitGate),

    tasks: async () => {
      const agent = loadAgent(stepDef(def, 'tasks').agent!);
      tasksHash = await runner.step('tasks', async () => {
        const plan = read<Plan>(planHash);
        const scratch = join(runDir, 'scratch', 'tasks');
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, 'plan.md'), untrusted('approved-plan', `${renderSpec(read<Spec>(specHash))}\n\n${renderPlan(plan)}`));
        const t = await agentStage<Tasks>({
          runner,
          agent: deps.author,
          spec: agent,
          task: { runId: input.runId, stepId: 'tasks', instructions: fill(agent.prompt, { feedback: feedback('tasks') }), scope: 'none', cwd: scratch, stateDir: join(runDir, 'agents', 'tasks'), tier: stepDef(def, 'tasks').tier!, timeoutMs },
          validate: (out) => validateTasks(out, plan),
        });
        return deps.artifacts.putJson('ticket.tasks', t, { runId: input.runId, plan: planHash }).hash;
      });
    },

    'review-artifacts': async () => {
      const agent = loadAgent(stepDef(def, 'review-artifacts').agent!);
      reviewHash = await runner.step('review-artifacts', async () => {
        let issues: ArtifactIssue[] = [];
        if (deps.critic) {
          const ws = await planningWorkspace();
          const bundle = [
            untrusted('ticket', text(packetHash)),
            untrusted('pbi', renderPbi(read<PbiManifest>(pbiHash))),
            untrusted('spec', renderSpec(read<Spec>(specHash))),
            untrusted('plan', renderPlan(read<Plan>(planHash))),
            untrusted('tasks', renderTasks(read<Tasks>(tasksHash))),
          ].join('\n\n');
          const r = await deps.critic.run({
            runId: input.runId,
            stepId: 'review-artifacts',
            instructions: fill(agent.prompt, { artifacts: bundle }),
            outputSchema: agent.schema,
            scope: 'read-repo',
            cwd: ws.dir,
            stateDir: join(runDir, 'agents', 'review-artifacts'),
            tier: stepDef(def, 'review-artifacts').tier!,
            timeoutMs,
          });
          runner.emit('AGENT_RUN', { step: 'review-artifacts', executor: deps.critic.id, agentVersion: agent.version, ok: r.ok, attempts: r.attempts, durationMs: r.durationMs, errors: r.errors.slice(0, 3) });
          if (r.ok) issues = (r.output as { issues: ArtifactIssue[] }).issues;
        }
        const bundle = {
          pbi: pbiHash,
          spec: specHash,
          plan: planHash,
          tasks: tasksHash,
          issues,
          critic: deps.critic?.id ?? 'none',
          traceability: renderTraceability(read<PbiManifest>(pbiHash), read<Spec>(specHash), read<Plan>(planHash)),
          review: renderIssues(issues),
        };
        return deps.artifacts.putJson('ticket.planning-bundle', bundle, { runId: input.runId }).hash;
      });
    },

    'gate-4': () => gateStep(runner, 'gate-4', 'GATE_4', reviewHash, deps.awaitGate),

    implement: async () => {
      implResult = await runner.step('implement', async () => {
        if (deps.env.level !== 'L2' || !deps.env.spec?.commands.testOne || !deps.env.approved) {
          throw new StageBlocked('implement', [`ENVIRONMENT_BLOCKED: the repo needs an approved L2 environment (have ${deps.env.level}${deps.env.approved ? '' : ', not approved at GATE_ENV'}); run gatehouse env verify and approve it`]);
        }
        const envSpec = deps.env.spec;
        const pbi = read<PbiManifest>(pbiHash);
        const spec = read<Spec>(specHash);
        const plan = read<Plan>(planHash);
        const tasks = topoSort(read<Tasks>(tasksHash).tasks);
        const ws = await deps.target.prepare({ runId: input.runId, repo: deps.repo.name, sha: base, slot: 'impl', reuse: true, env: envSpec });
        await git(['-C', ws.dir, 'checkout', '-q', '-B', `gatehouse/work-${input.runId.slice(-8)}`]);
        // Hide agent instruction files from the agents without ever committing their removal.
        await hideFromCommits(ws.dir, maskAgentInstructions(ws.dir, join(runDir, 'masked-impl')));
        const startSha = await git(['-C', ws.dir, 'rev-parse', 'HEAD']);
        const context = untrusted('approved-context', `${renderSpec(spec)}\n\n${renderPlan(plan)}`);
        const logs: TaskLog[] = [];
        for (const t of tasks) {
          log(`  task ${t.id}: ${t.title}`);
          const steps = plan.steps.filter((s) => t.step_ids.includes(s.id));
          const scenarios = pbi.scenarios.filter((s) => t.scenario_ids.includes(s.id));
          logs.push(
            await tddCycle(
              {
                id: t.id,
                title: t.title,
                testClass: t.test_class,
                task: untrusted('task', `${t.title}\nPlan steps:\n${steps.map((s) => `- ${s.id}: ${s.description} (${s.files.map((f) => `${f.change} ${f.path}`).join(', ')})`).join('\n')}\nFiles: ${t.files.join(', ')}`),
                scenarios: untrusted('scenarios', scenarios.map((s) => `- ${s.id}: Given ${s.given}; when ${s.when}; then ${s.then}`).join('\n')),
                context,
              },
              {
                runner,
                target: deps.target,
                ws,
                env: envSpec,
                agent: deps.author,
                testWriter: loadAgent(stepParam(def, 'implement', 'testWriter', 'test-writer')),
                implementer: loadAgent(stepParam(def, 'implement', 'implementer', 'implementer')),
                runId: input.runId,
                runDir,
                tier: stepDef(def, 'implement').tier!,
                timeoutMs,
                mode: 'red-green',
                log,
              },
            ),
          );
        }
        // Regression check against the approved baseline.
        const regressions: string[] = [];
        if (envSpec.commands.testAll && deps.env.baseline?.tool === 'surefire') {
          await deps.target.exec(ws, envSpec.commands.testAll.argv, { timeoutMs: timeoutMs * 2 });
          const now = new Map(readSurefireReports(ws.dir).map((t) => [t.id, t.status] as const));
          for (const [id, status] of Object.entries(deps.env.baseline.tests)) if (status === 'passed' && now.get(id) === 'failed') regressions.push(id);
          runner.emit('REGRESSION_CHECK', { regressions });
        }
        const head = await git(['-C', ws.dir, 'rev-parse', 'HEAD']);
        if (head === startSha) throw new StageBlocked('implement', ['no change was produced']);
        await git(['-C', deps.repo.mirror, 'fetch', '-q', ws.dir, `+HEAD:refs/gatehouse/runs/${input.runId}`]);
        const numstat = await git(['-C', ws.dir, 'diff', '--numstat', startSha, head]);
        const rows = numstat.split('\n').filter(Boolean).map((l) => l.split('\t'));
        const stats = { files: rows.length, insertions: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0), deletions: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0) };
        const maxLoc = stepParam(def, 'implement', 'maxLoc', 400);
        const warnings = [
          ...(stats.insertions + stats.deletions > maxLoc ? [`patch is ${stats.insertions + stats.deletions} changed lines (autonomy ceiling ${maxLoc})`] : []),
          ...logs.filter((l) => l.red.note).map((l) => `${l.task}: ${l.red.note}`),
          ...logs.filter((l) => l.green.outcome !== 'GREEN').map((l) => `${l.task}: test ${l.testClass} is not passing`),
          ...(regressions.length ? [`${regressions.length} previously passing test(s) now fail`] : []),
        ];
        if (!input.keepWorkspaces) await deps.target.destroy(ws);
        return { head, tasksLog: deps.artifacts.putJson('ticket.implementation-log', logs, { runId: input.runId }).hash, regressions, stats, warnings };
      });
    },

    'code-review': async () => {
      reviewResult = await runner.step('code-review', async () => {
        const pbi = read<PbiManifest>(pbiHash);
        return deps.review({
          base,
          head: `refs/gatehouse/runs/${input.runId}`,
          title: `${input.ticketKey}: ${pbi.title}`,
          body: `${pbi.problem}\n\nAcceptance criteria:\n${pbi.acceptance_criteria.map((a) => `- ${a.id}: ${a.text}`).join('\n')}`,
        });
      });
    },

    package: async () => {
      packageHash = await runner.step('package', async () => {
        const pbi = read<PbiManifest>(pbiHash);
        const pkg: TicketPackage = {
          version: 1,
          runId: input.runId,
          repo: deps.repo.name,
          ticket: input.ticketKey,
          title: pbi.title,
          base,
          head: implResult.head,
          branch: `gatehouse/${input.ticketKey.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${input.runId.slice(-6).toLowerCase()}`,
          artifacts: { packet: packetHash, pbi: pbiHash, spec: specHash, plan: planHash, tasks: tasksHash, planningReview: reviewHash, implementationLog: implResult.tasksLog, review: reviewResult.packageHash },
          tasks: read<TaskLog[]>(implResult.tasksLog),
          regressions: implResult.regressions,
          stats: implResult.stats,
          review: { packageHash: reviewResult.packageHash, postable: reviewResult.postable },
          warnings: implResult.warnings,
        };
        const summary = renderTicketSummary(pkg, pbi, read<Spec>(specHash), read<Plan>(planHash));
        pkg.artifacts.summary = deps.artifacts.put('ticket.summary.md', summary, 'text/markdown', { runId: input.runId }).hash;
        const art = deps.artifacts.putJson('ticket.package', pkg, { runId: input.runId });
        const outDir = join(runDir, 'out');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'TICKET.md'), summary);
        return art.hash;
      });
    },

    'gate-5': async () => {
      await runner.step('gate-5', async () => {
        runner.emit('AWAITING_GATE', { gate: 'GATE_5', artifact: packageHash });
        return { gate: 'GATE_5', artifact: packageHash };
      });
    },
  });

  for (const s of steps) await s.impl();
  if (planWs && !input.keepWorkspaces) await deps.target.destroy(planWs);
  return read<TicketPackage>(packageHash);
}

export function renderTicketSummary(pkg: TicketPackage, pbi: PbiManifest, spec: Spec, plan: Plan): string {
  return [
    `# ${pkg.ticket}: ${pkg.title}`,
    '',
    `Run \`${pkg.runId}\` · base \`${pkg.base.slice(0, 10)}\` → head \`${pkg.head.slice(0, 10)}\` · ${pkg.stats.files} file(s), +${pkg.stats.insertions}/−${pkg.stats.deletions}`,
    `Branch to publish: \`${pkg.branch}\` (draft PR after GATE_5).`,
    '',
    ...(pkg.warnings.length ? ['## Warnings', ...pkg.warnings.map((w) => `- ${w}`), ''] : []),
    '## Test-first evidence',
    '| Task | Test | Failed first | Passes now | Reverted by Gatehouse |',
    '|---|---|---|---|---|',
    ...pkg.tasks.map((t) => `| ${t.task} | \`${t.testClass.split('.').pop()}\` | ${t.red.outcome === 'RED' ? 'yes' : `no (${t.red.outcome})`} | ${t.green.outcome === 'GREEN' ? 'yes' : 'NO'} | ${t.reverted.length ? t.reverted.join(', ') : '—'} |`),
    '',
    `Regressions against the approved baseline: ${pkg.regressions.length ? pkg.regressions.join(', ') : 'none'}.`,
    `Code review of the patch: ${pkg.review.postable} finding(s) (package ${pkg.review.packageHash.slice(0, 12)}).`,
    '',
    renderTraceability(pbi, spec, plan),
  ].join('\n');
}

