import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { type ArtifactStore, type EventStore, type GatehouseConfig, type RepoRecord } from '@gatehouse/core';
import { StepRunner } from '@gatehouse/engine';
import type { EnvSpec } from '@gatehouse/env';
import type { ExecutorAdapter } from '@gatehouse/harness';
import { fetchMirror, git, maskAgentInstructions, resolveCommit, type ExecutionTarget, type Workspace } from '@gatehouse/targets';
import { owningModule } from './evidence.ts';
import { branchPct, linePct, readJacoco, type ClassCoverage } from './jacoco.ts';
import { StageBlocked, agentStage, gateStep, hideFromCommits } from './pipeline.ts';
import { escapeHtml } from './render.ts';
import { fill, loadAgent, untrusted } from './registry.ts';
import { tddCycle, type TaskLog } from './tdd.ts';
import { bindSteps, loadWorkflow, stepDef, stepParam } from './workflow-def.ts';

export interface LegacyDeps {
  config: GatehouseConfig;
  events: EventStore;
  artifacts: ArtifactStore;
  repo: RepoRecord;
  target: ExecutionTarget;
  runsDir: string;
  author: ExecutorAdapter;
  critic: ExecutorAdapter | null;
  env: { level: string; spec: EnvSpec | null; approved: boolean };
  awaitGate: (gate: string, artifact: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface LegacyInput {
  runId: string;
  /** Optional package prefix to focus on, e.g. com.acme.pricing */
  scope?: string;
  maxTargets?: number;
  keepWorkspaces?: boolean;
}

interface Triage {
  backlog: Array<{ class_name: string; reason: string; priority: 'high' | 'medium' | 'low'; risk: string }>;
}

interface Charter {
  charters: Array<{
    class_name: string;
    test_class: string;
    fixtures_reused: string[];
    scenarios: Array<{ id: string; method: string; given: string; when: string; then: string; kind: 'happy' | 'negative' | 'boundary' }>;
  }>;
}

interface TestIssue {
  severity: 'blocker' | 'major' | 'minor';
  test_class: string;
  description: string;
  evidence: string;
}

export interface LegacyPackage {
  version: 1;
  runId: string;
  repo: string;
  base: string;
  head: string;
  branch: string;
  targets: Array<{ className: string; before: Cov; after: Cov; testClass: string; status: TaskLog['red']['outcome']; reverted: string[] }>;
  issues: TestIssue[];
  artifacts: Record<string, string>;
  warnings: string[];
}

type Cov = { line: number; branch: number; lineMissed: number };

const cov = (c: ClassCoverage | undefined): Cov => (c ? { line: Math.round(linePct(c) * 10) / 10, branch: Math.round(branchPct(c) * 10) / 10, lineMissed: c.lineMissed } : { line: 0, branch: 0, lineMissed: 0 });

/**
 * Legacy test coverage (registry/workflows/legacy-tests.yaml). Coverage numbers come from JaCoCo
 * runs by trusted code before and after; characterization tests must pass on unchanged code; the
 * agent may only touch test files; a human approves targets, charters, the measured delta and the
 * final test review.
 */
export async function runLegacyTests(deps: LegacyDeps, input: LegacyInput): Promise<LegacyPackage> {
  const def = loadWorkflow('legacy-tests');
  const log = deps.log ?? (() => undefined);
  const runner = new StepRunner(deps.events, input.runId, log);
  const runDir = join(deps.runsDir, input.runId);
  const timeoutMs = deps.config.review.stepTimeoutMinutes * 60_000;
  const read = <T>(hash: string) => JSON.parse(deps.artifacts.read(hash).toString('utf8')) as T;
  const feedback = (stage: string) => {
    const notes = deps.events.list(input.runId).filter((e) => e.type === 'REVIEWER_NOTE' && (e.payload as { stage: string }).stage === stage).map((e) => (e.payload as { note: string }).note);
    return notes.length ? `\n## Reviewer feedback from the previous attempt\n${notes.map((n) => `- ${n}`).join('\n')}` : '';
  };
  if (deps.env.level !== 'L2' || !deps.env.approved || !deps.env.spec?.commands.coverage || deps.env.spec.stack !== 'java-maven') {
    throw new StageBlocked('inventory', [`ENVIRONMENT_BLOCKED: legacy tests need an approved L2 java-maven environment with a coverage command (have ${deps.env.level}${deps.env.approved ? '' : ', not approved'})`]);
  }
  const envSpec = deps.env.spec;

  let base = '';
  let inventoryHash = '';
  let triageHash = '';
  let charterHash = '';
  let implHash = '';
  let afterHash = '';
  let issuesHash = '';
  let packageHash = '';
  let ws: Workspace | null = null;
  const workspace = async (): Promise<Workspace> => {
    if (!ws) {
      ws = await deps.target.prepare({ runId: input.runId, repo: deps.repo.name, sha: base, slot: 'tests', reuse: true, env: envSpec });
      const branch = `gatehouse/tests-${input.runId.slice(-8)}`;
      const current = await git(['-C', ws.dir, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
      if (current !== branch) await git(['-C', ws.dir, 'checkout', '-q', '-B', branch]);
      await hideFromCommits(ws.dir, maskAgentInstructions(ws.dir, join(runDir, 'masked')));
    }
    return ws;
  };
  const coverage = async (w: Workspace, label: string): Promise<ClassCoverage[]> => {
    const r = await deps.target.exec(w, envSpec.commands.coverage!.argv, { timeoutMs: timeoutMs * 3 });
    const classes = readJacoco(w.dir);
    runner.emit('COVERAGE_RUN', { label, code: r.code, classes: classes.length, durationMs: r.durationMs });
    if (!classes.length) throw new Error(`no JaCoCo report was produced (${label}, exit ${r.code})`);
    return classes;
  };

  const steps = bindSteps<() => Promise<void>>(def, {
    inventory: async () => {
      const r = await runner.step('inventory', async () => {
        await fetchMirror(deps.repo.mirror).catch(() => undefined);
        const sha = await resolveCommit(deps.repo.mirror, deps.repo.defaultBranch);
        base = sha;
        const classes = (await coverage(await workspace(), 'before')).filter((c) => !input.scope || c.className.startsWith(input.scope));
        return { base: sha, inventory: deps.artifacts.putJson('legacy.inventory', classes, { runId: input.runId, sha }).hash };
      });
      base = r.base;
      inventoryHash = r.inventory;
    },

    triage: async () => {
      const agent = loadAgent(stepDef(def, 'triage').agent!);
      const maxTargets = input.maxTargets ?? stepParam(def, 'triage', 'maxTargets', 3);
      triageHash = await runner.step('triage', async () => {
        const inventory = read<ClassCoverage[]>(inventoryHash);
        const rows = inventory.filter((c) => c.lineMissed > 0).slice(0, stepParam(def, 'inventory', 'inventoryRows', 40));
        const table = rows.map((c) => `- ${c.className} — lines ${linePct(c).toFixed(0)}% (${c.lineMissed} missed), branches ${branchPct(c).toFixed(0)}%, ${c.methods} methods${c.path ? `, ${c.path}` : ''}`).join('\n');
        const w = await workspace();
        const t = await agentStage<Triage>({
          runner,
          agent: deps.author,
          spec: agent,
          task: { runId: input.runId, stepId: 'triage', instructions: fill(agent.prompt, { inventory: table, maxTargets: String(maxTargets), feedback: feedback('triage') }), scope: 'read-repo', cwd: w.dir, stateDir: join(runDir, 'agents', 'triage'), tier: stepDef(def, 'triage').tier!, timeoutMs },
          validate: (out) => [
            ...(out.backlog.length ? [] : ['choose at least one class']),
            ...(out.backlog.length > maxTargets ? [`choose at most ${maxTargets} classes`] : []),
            ...out.backlog.filter((b) => !rows.some((r) => r.className === b.class_name)).map((b) => `${b.class_name} is not in the inventory`),
          ],
        });
        return deps.artifacts.putJson('legacy.triage', t, { runId: input.runId }).hash;
      });
    },

    'gate-1': () => gateStep(runner, 'gate-1', 'GATE_1', triageHash, deps.awaitGate),

    charter: async () => {
      const agent = loadAgent(stepDef(def, 'charter').agent!);
      charterHash = await runner.step('charter', async () => {
        const triage = read<Triage>(triageHash);
        const inventory = read<ClassCoverage[]>(inventoryHash);
        const w = await workspace();
        const targets = triage.backlog.map((b) => {
          const c = inventory.find((x) => x.className === b.class_name);
          return `- ${b.class_name} (${c?.path ?? 'path unknown'}): ${b.reason}`;
        });
        const c = await agentStage<Charter>({
          runner,
          agent: deps.author,
          spec: agent,
          task: { runId: input.runId, stepId: 'charter', instructions: fill(agent.prompt, { targets: targets.join('\n'), feedback: feedback('charter') }), scope: 'read-repo', cwd: w.dir, stateDir: join(runDir, 'agents', 'charter'), tier: stepDef(def, 'charter').tier!, timeoutMs },
          validate: (out) => validateCharter(out, triage, inventory, w.dir),
        });
        return deps.artifacts.putJson('legacy.charter', c, { runId: input.runId }).hash;
      });
    },

    'gate-2': () => gateStep(runner, 'gate-2', 'GATE_2', charterHash, deps.awaitGate),

    'implement-tests': async () => {
      implHash = await runner.step('implement-tests', async () => {
        const charter = read<Charter>(charterHash);
        const inventory = read<ClassCoverage[]>(inventoryHash);
        const w = await workspace();
        const logs: TaskLog[] = [];
        for (const [i, ch] of charter.charters.entries()) {
          const src = inventory.find((c) => c.className === ch.class_name)?.path;
          log(`  tests for ${ch.class_name}`);
          logs.push(
            await tddCycle(
              {
                id: `C${i + 1}`,
                title: `characterize ${ch.class_name}`,
                testClass: ch.test_class,
                task: untrusted('charter', `Class under test: ${ch.class_name}${src ? ` (${src})` : ''}\nTest class: ${ch.test_class}\nReuse fixtures: ${ch.fixtures_reused.join(', ') || 'none'}`),
                scenarios: untrusted('scenarios', ch.scenarios.map((s) => `- ${s.id} [${s.kind}] ${s.method}: Given ${s.given}; when ${s.when}; then ${s.then}`).join('\n')),
                context: src ? `Read ${src} first.` : '',
              },
              {
                runner,
                target: deps.target,
                ws: w,
                env: envSpec,
                agent: deps.author,
                testWriter: loadAgent(stepDef(def, 'implement-tests').agent!),
                implementer: loadAgent(stepDef(def, 'implement-tests').agent!),
                runId: input.runId,
                runDir,
                tier: stepDef(def, 'implement-tests').tier!,
                timeoutMs,
                mode: 'characterize',
                log,
              },
            ),
          );
          const testFile = testPath(w.dir, ch.test_class, src);
          if (testFile && existsSync(testFile) && !/\b(assert\w*|expect|verify|should)\s*[.(]/.test(readFileSync(testFile, 'utf8'))) {
            runner.emit('ASSERTION_FREE_TEST', { testClass: ch.test_class });
            logs[logs.length - 1]!.red.note = 'test file contains no assertions';
          }
        }
        return deps.artifacts.putJson('legacy.implementation-log', logs, { runId: input.runId }).hash;
      });
    },

    'verify-coverage': async () => {
      afterHash = await runner.step('verify-coverage', async () => {
        const after = await coverage(await workspace(), 'after');
        return deps.artifacts.putJson('legacy.coverage-after', after, { runId: input.runId }).hash;
      });
    },

    'gate-3': () => gateStep(runner, 'gate-3', 'GATE_3', afterHash, deps.awaitGate),

    review: async () => {
      const agent = loadAgent(stepDef(def, 'review').agent!);
      issuesHash = await runner.step('review', async () => {
        let issues: TestIssue[] = [];
        const w = await workspace();
        if (deps.critic) {
          const diff = await git(['-C', w.dir, 'diff', base, 'HEAD', '--', '.']);
          const r = await deps.critic.run({
            runId: input.runId,
            stepId: 'review',
            instructions: fill(agent.prompt, { tests: untrusted('new-tests', diff.slice(0, 120_000)) }),
            outputSchema: agent.schema,
            scope: 'read-repo',
            cwd: w.dir,
            stateDir: join(runDir, 'agents', 'review'),
            tier: stepDef(def, 'review').tier!,
            timeoutMs,
          });
          runner.emit('AGENT_RUN', { step: 'review', executor: deps.critic.id, agentVersion: agent.version, ok: r.ok, attempts: r.attempts, durationMs: r.durationMs, errors: r.errors.slice(0, 3) });
          if (r.ok) issues = (r.output as { issues: TestIssue[] }).issues;
        }
        return deps.artifacts.putJson('legacy.test-review', issues, { runId: input.runId, critic: deps.critic?.id ?? 'none' }).hash;
      });
    },

    package: async () => {
      packageHash = await runner.step('package', async () => {
        const w = await workspace();
        const head = await git(['-C', w.dir, 'rev-parse', 'HEAD']);
        if (head === base) throw new StageBlocked('package', ['no tests were committed']);
        await git(['-C', deps.repo.mirror, 'fetch', '-q', w.dir, `+HEAD:refs/gatehouse/runs/${input.runId}`]);
        const before = new Map(read<ClassCoverage[]>(inventoryHash).map((c) => [c.className, c]));
        const after = new Map(read<ClassCoverage[]>(afterHash).map((c) => [c.className, c]));
        const charter = read<Charter>(charterHash);
        const logs = read<TaskLog[]>(implHash);
        const targets = charter.charters.map((ch, i) => ({
          className: ch.class_name,
          before: cov(before.get(ch.class_name)),
          after: cov(after.get(ch.class_name)),
          testClass: ch.test_class,
          status: logs[i]?.red.outcome ?? 'NO_RUN',
          reverted: logs[i]?.reverted ?? [],
        }));
        const issues = read<TestIssue[]>(issuesHash);
        const pkg: LegacyPackage = {
          version: 1,
          runId: input.runId,
          repo: deps.repo.name,
          base,
          head,
          branch: `gatehouse/tests-${input.runId.slice(-8).toLowerCase()}`,
          targets,
          issues,
          artifacts: { inventory: inventoryHash, triage: triageHash, charter: charterHash, implementation: implHash, coverageAfter: afterHash, review: issuesHash },
          warnings: [
            ...targets.filter((t) => t.status !== 'GREEN').map((t) => `${t.testClass} does not pass (${t.status})`),
            ...targets.filter((t) => t.after.line <= t.before.line).map((t) => `${t.className}: line coverage did not improve`),
            ...logs.filter((l) => l.red.note).map((l) => `${l.testClass}: ${l.red.note}`),
            ...issues.filter((x) => x.severity === 'blocker').map((x) => `blocker from test review: ${x.test_class}: ${x.description}`),
          ],
        };
        pkg.artifacts.summary = deps.artifacts.put('legacy.summary.md', renderCoverageMd(pkg), 'text/markdown', { runId: input.runId }).hash;
        const art = deps.artifacts.putJson('legacy.package', pkg, { runId: input.runId });
        const outDir = join(runDir, 'out');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'COVERAGE.md'), renderCoverageMd(pkg));
        writeFileSync(join(outDir, 'coverage-report.html'), renderCoverageHtml(pkg));
        return art.hash;
      });
    },

    'gate-4': async () => {
      await runner.step('gate-4', async () => {
        runner.emit('AWAITING_GATE', { gate: 'GATE_4', artifact: packageHash });
        return { gate: 'GATE_4', artifact: packageHash };
      });
    },
  });

  for (const s of steps) await s.impl();
  if (ws && !input.keepWorkspaces) await deps.target.destroy(ws);
  return read<LegacyPackage>(packageHash);
}

function validateCharter(c: Charter, triage: Triage, inventory: ClassCoverage[], ws: string): string[] {
  const p: string[] = [];
  const ids: string[] = [];
  for (const b of triage.backlog) if (!c.charters.some((x) => x.class_name === b.class_name)) p.push(`no charter for ${b.class_name}`);
  for (const ch of c.charters) {
    if (!triage.backlog.some((b) => b.class_name === ch.class_name)) p.push(`${ch.class_name} was not an approved target`);
    if (!/^[a-z_][\w]*(\.[a-z_][\w]*)*\.[A-Z]\w*GatehouseTest$/.test(ch.test_class)) p.push(`${ch.test_class}: use a fully qualified name in the same package ending in GatehouseTest`);
    const pkg = ch.class_name.split('.').slice(0, -1).join('.');
    if (!ch.test_class.startsWith(`${pkg}.`)) p.push(`${ch.test_class} must be in package ${pkg}`);
    const tp = testPath(ws, ch.test_class, inventory.find((x) => x.className === ch.class_name)?.path);
    if (tp && existsSync(tp)) p.push(`${ch.test_class} already exists`);
    if (ch.scenarios.length < 2) p.push(`${ch.class_name} needs at least two scenarios`);
    if (!ch.scenarios.some((s) => s.kind !== 'happy')) p.push(`${ch.class_name} needs a negative or boundary scenario`);
    for (const f of ch.fixtures_reused) if (!resolve(ws, f).startsWith(resolve(ws) + sep) || !existsSync(resolve(ws, f))) p.push(`fixture ${f} does not exist`);
    ids.push(...ch.scenarios.map((s) => s.id));
  }
  for (const id of ids) if (!/^SCN-\d+$/.test(id)) p.push(`scenario id ${id} must look like SCN-1`);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) p.push(`duplicate scenario id ${d}`);
  return p;
}

/** Where a test class lives: the module owning the class under test, src/test/java/<package path>. */
function testPath(ws: string, testClass: string, sourcePath: string | null | undefined): string | null {
  const module = sourcePath ? owningModule(ws, sourcePath) : ws;
  return join(module, 'src', 'test', 'java', ...testClass.split('.')) + '.java';
}

export function renderCoverageMd(pkg: LegacyPackage): string {
  return [
    `# Legacy test coverage — ${pkg.repo}`,
    '',
    `Run \`${pkg.runId}\` · base \`${pkg.base.slice(0, 10)}\` → \`${pkg.head.slice(0, 10)}\` · branch \`${pkg.branch}\``,
    '',
    ...(pkg.warnings.length ? ['## Warnings', ...pkg.warnings.map((w) => `- ${w}`), ''] : []),
    '| Class | Lines before → after | Branches before → after | Test | Passes |',
    '|---|---|---|---|---|',
    ...pkg.targets.map((t) => `| \`${t.className}\` | ${t.before.line}% → ${t.after.line}% | ${t.before.branch}% → ${t.after.branch}% | \`${t.testClass.split('.').pop()}\` | ${t.status === 'GREEN' ? 'yes' : t.status} |`),
    '',
    '## Test review',
    ...(pkg.issues.length ? pkg.issues.map((i) => `- **${i.severity}** ${i.test_class}: ${i.description}${i.evidence ? ` — ${i.evidence}` : ''}`) : ['_No issues._']),
    '',
  ].join('\n');
}

export function renderCoverageHtml(pkg: LegacyPackage): string {
  const e = escapeHtml;
  const rows = pkg.targets
    .map((t) => `<tr><td><code>${e(t.className)}</code></td><td>${t.before.line}% → <b>${t.after.line}%</b></td><td>${t.before.branch}% → <b>${t.after.branch}%</b></td><td><code>${e(t.testClass)}</code></td><td>${t.status === 'GREEN' ? 'passes' : e(t.status)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Coverage · ${e(pkg.repo)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1c1c1a;background:#fafaf8}@media (prefers-color-scheme:dark){body{color:#ecece8;background:#161615}}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #8884;padding:6px 8px;text-align:left}code{font-size:13px}</style>
</head><body><h1>Legacy test coverage — ${e(pkg.repo)}</h1><p>Run ${e(pkg.runId)} · branch <code>${e(pkg.branch)}</code></p>
${pkg.warnings.map((w) => `<p>⚠ ${e(w)}</p>`).join('')}
<table><thead><tr><th>Class</th><th>Lines</th><th>Branches</th><th>Test</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Test review</h2>${pkg.issues.length ? `<ul>${pkg.issues.map((i) => `<li><b>${e(i.severity)}</b> ${e(i.test_class)}: ${e(i.description)}</li>`).join('')}</ul>` : '<p>No issues.</p>'}
</body></html>`;
}

export const _legacyInternal = { validateCharter, testPath };
