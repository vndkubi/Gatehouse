import { existsSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  ArtifactStore,
  EventStore,
  RepoRegistry,
  gatehousePaths,
  loadConfig,
  validRepoName,
  type GatehousePaths,
  type RepoRecord,
} from '@gatehouse/core';
import { detectFacts, provenanceLabel, synthesize, type EnvLevel, type EnvSpec, type VerifyReport } from '@gatehouse/env';
import { onboardJob, openRuntime } from '@gatehouse/app';
import { HostTarget, createMirror, defaultBranch, fetchMirror, resolveCommit, scrubEnv, takeFingerprint } from '@gatehouse/targets';

interface Ctx {
  paths: GatehousePaths;
  repos: RepoRegistry;
  events: EventStore;
  artifacts: ArtifactStore;
  close(): void;
}

function context(): Ctx {
  const { config } = loadConfig({ projectDir: process.cwd() });
  const paths = gatehousePaths(config.paths.home);
  const repos = new RepoRegistry(paths.db);
  const events = new EventStore(paths.db);
  return {
    paths,
    repos,
    events,
    artifacts: new ArtifactStore(paths.artifacts),
    close: () => {
      repos.close();
      events.close();
    },
  };
}

const out = (s = '') => process.stdout.write(`${s}\n`);

export async function repoAdd(source: string, flags: Record<string, string | boolean>): Promise<number> {
  const ctx = context();
  try {
    const looksLocal = existsSync(source);
    const src = looksLocal ? resolve(source) : source;
    const name = typeof flags.name === 'string' ? flags.name : basename(src).replace(/\.git$/, '');
    if (!validRepoName(name)) throw new Error(`cannot derive a valid repo name from ${source}; pass --name`);
    if (ctx.repos.get(name)) throw new Error(`repo ${name} is already registered`);
    const scope = typeof flags.pci === 'string' ? flags.pci : 'out';
    if (!['cde', 'connected', 'out'].includes(scope)) throw new Error('--pci must be cde, connected or out');

    const mirror = resolve(ctx.paths.mirrors, `${name}.git`);
    out(`Mirroring ${src} -> ${mirror} ...`);
    await createMirror(src, mirror);
    const branch = typeof flags.branch === 'string' ? flags.branch : await defaultBranch(mirror);
    const record: RepoRecord = { name, source: src, mirror, defaultBranch: branch, pciScope: scope as RepoRecord['pciScope'], addedAt: new Date().toISOString() };
    ctx.repos.add(record);
    ctx.events.append(`repo:${name}`, 'REPO_ADDED', { source: src, defaultBranch: branch, pciScope: scope });
    out(`Registered ${name} (default branch ${branch}, pci scope ${scope}).`);
    out(`Next: gatehouse env verify ${name}`);
    return 0;
  } finally {
    ctx.close();
  }
}

export function repoList(json: boolean): number {
  const ctx = context();
  try {
    const list = ctx.repos.list();
    if (json) out(JSON.stringify(list, null, 2));
    else if (!list.length) out('No repos registered. Add one with: gatehouse repo add <path|url>');
    else for (const r of list) out(`${r.name.padEnd(30)} ${r.defaultBranch.padEnd(12)} pci:${r.pciScope.padEnd(10)} ${r.source}`);
    return 0;
  } finally {
    ctx.close();
  }
}

/** Unregisters a repo and deletes Gatehouse's mirror; the user's own checkout is never touched. */
export function repoRemove(name: string): number {
  const ctx = context();
  try {
    const repo = mustGet(ctx, name);
    ctx.repos.remove(name);
    rmSync(repo.mirror, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    ctx.events.append(`repo:${name}`, 'REPO_REMOVED', { mirror: repo.mirror });
    out(`Removed ${name} and its mirror.`);
    return 0;
  } finally {
    ctx.close();
  }
}

export async function repoFetch(name: string): Promise<number> {
  const ctx = context();
  try {
    const repo = mustGet(ctx, name);
    await fetchMirror(repo.mirror);
    out(`Fetched ${name}.`);
    return 0;
  } finally {
    ctx.close();
  }
}

/** Detect + synthesize only; nothing from the repo is executed. */
export async function envDetect(name: string, flags: Record<string, string | boolean>): Promise<number> {
  const ctx = context();
  const target = hostTarget(ctx);
  try {
    const repo = mustGet(ctx, name);
    const ref = typeof flags.ref === 'string' ? flags.ref : repo.defaultBranch;
    const sha = await resolveCommit(repo.mirror, ref);
    const ws = await target.prepare({ runId: `detect-${name}-${Date.now()}`, repo: name, sha });
    try {
      const facts = detectFacts(ws.dir);
      const fingerprint = await takeFingerprint(scrubEnv(process.env).env);
      const spec = synthesize({ repo: name, derivedFrom: { ref, sha }, target: 'host', facts, fingerprint });
      if (flags.json) out(JSON.stringify({ facts, spec }, null, 2));
      else printSpec(spec, facts.length);
      return 0;
    } finally {
      await target.destroy(ws);
    }
  } finally {
    ctx.close();
  }
}

export async function envVerify(name: string, flags: Record<string, string | boolean>): Promise<number> {
  const rt = openRuntime();
  try {
    const target = flags.target === 'cell' ? 'cell' : flags.target === 'host' ? 'host' : undefined;
    const o = await onboardJob(rt, {
      repo: name,
      ref: typeof flags.ref === 'string' ? flags.ref : undefined,
      maxLevel: (typeof flags.level === 'string' ? flags.level.toUpperCase() : 'L2') as EnvLevel,
      fetch: !flags['no-fetch'],
      keep: Boolean(flags.keep),
      target,
    }, out);
    if (o.result) {
      printSpec(o.result.spec, o.result.facts);
      printReport(o.result.report);
      out(`
Artifacts: spec ${o.result.specHash.slice(0, 12)}  report ${o.result.reportHash.slice(0, 12)}  (run ${o.runId})`);
    }
    out(o.message);
    return o.result?.report.level === 'L0' ? 1 : 0;
  } finally {
    rt.close();
  }
}

function hostTarget(ctx: Ctx): HostTarget {
  return new HostTarget({
    runsDir: ctx.paths.runs,
    mirrorFor: (repo) => mustGet(ctx, repo).mirror,
  });
}

function mustGet(ctx: Ctx, name: string): RepoRecord {
  const repo = ctx.repos.get(name);
  if (!repo) throw new Error(`unknown repo ${name}; register it with: gatehouse repo add <path|url>`);
  return repo;
}

function printSpec(spec: EnvSpec, factCount: number): void {
  out(`Stack: ${spec.stack}   (${factCount} facts detected, ${spec.derivedFrom.ref} @ ${spec.derivedFrom.sha.slice(0, 10)})`);
  for (const [tool, t] of Object.entries(spec.toolchain)) {
    const want = t.requirement ? `needs ${t.requirement}` : 'no requirement';
    const have = t.measured ? `, host has ${t.measured}` : '';
    out(`  ${tool.padEnd(6)} ${want}${have}   [${provenanceLabel(t.provenance)}]`);
  }
  for (const s of spec.services) out(`  service ${s.name} (${s.image ?? s.kind})   [${provenanceLabel(s.provenance)}]`);
  for (const [name, c] of Object.entries(spec.commands)) {
    if (c) out(`  ${name.padEnd(8)} ${c.argv.join(' ')}   [${provenanceLabel(c.provenance)}]`);
  }
  if (spec.needs.containerRuntime) out('  needs   container runtime (Testcontainers)');
  for (const w of spec.warnings) out(`  ! ${w}`);
}

function printReport(report: VerifyReport): void {
  out(`\nLevel reached: ${report.level}`);
  if (report.baseline && report.baseline.tool === 'surefire') {
    const s = report.baseline.summary;
    out(`Baseline: ${s.total} tests — ${s.passed} passed, ${s.failed} failing before any change, ${s.flaky} flaky, ${s.skipped} skipped`);
  }
  for (const r of report.reasons) out(`  - ${r}`);
}
