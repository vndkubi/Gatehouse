import { existsSync, readFileSync } from 'node:fs';
import { homedir, totalmem, cpus } from 'node:os';
import { join } from 'node:path';
import type { Baseline, VerifyReport } from '@gatehouse/env';
import { git, run } from '@gatehouse/targets';
import { latestEnv } from '@gatehouse/workflows';
import { CellTarget, cacheVolume, imageFor } from './cell-target.ts';
import type { Runtime } from './runtime.ts';

// ---- B0: host ↔ cell parity -------------------------------------------------------------------

export interface ParityReport {
  host: { run: string; level: string; summary: Baseline['summary'] } | null;
  cell: { run: string; level: string; summary: Baseline['summary'] } | null;
  /** Tests whose outcome differs (flaky on either side is not a difference). */
  differences: Array<{ test: string; host: string; cell: string }>;
  onlyOnHost: string[];
  onlyInCell: string[];
  /** Host-passing tests that cannot run in this cell because they start containers (Testcontainers). Expected, not a failure. */
  needsContainerRuntime: string[];
  ok: boolean;
  notes: string[];
}

/**
 * Compares two test baselines. Flaky tests are notes, not mismatches. Tests of classes in
 * `containerClasses` that are skipped or absent in the cell are expected when the cell runtime
 * provides no Docker, and are listed separately.
 */
export function compareBaselines(
  host: Baseline,
  cell: Baseline,
  containerClasses: Set<string> = new Set(),
): Pick<ParityReport, 'differences' | 'onlyOnHost' | 'onlyInCell' | 'needsContainerRuntime' | 'notes'> {
  const differences: ParityReport['differences'] = [];
  const notes: string[] = [];
  const needsContainerRuntime: string[] = [];
  const containerTest = (t: string) => containerClasses.has(t.split('#')[0]!);
  for (const [test, h] of Object.entries(host.tests)) {
    const c = cell.tests[test];
    if (c === undefined || c === h) continue;
    if (h === 'flaky' || c === 'flaky') notes.push(`${test} is flaky (${h} on host, ${c} in cell)`);
    else if (c === 'skipped' && containerTest(test)) needsContainerRuntime.push(test);
    else differences.push({ test, host: h, cell: c });
  }
  const onlyOnHost: string[] = [];
  for (const t of Object.keys(host.tests).filter((x) => !(x in cell.tests))) (containerTest(t) ? needsContainerRuntime : onlyOnHost).push(t);
  const onlyInCell = Object.keys(cell.tests).filter((t) => !(t in host.tests)).sort();
  return { differences: differences.sort((a, b) => a.test.localeCompare(b.test)), onlyOnHost: onlyOnHost.sort(), onlyInCell, needsContainerRuntime: needsContainerRuntime.sort(), notes };
}

/** Test classes that start containers, found in the source at `sha` (deterministic, no build needed). */
export async function containerTestClasses(mirror: string, sha: string): Promise<Set<string>> {
  const out = await git(['-C', mirror, 'grep', '-l', '-i', '-E', 'org\\.testcontainers|@Testcontainers|@ServiceConnection', sha, '--', '*.java', '*.kt'], { raw: true }).catch(() => '');
  const classes = new Set<string>();
  for (const line of out.split('\n')) {
    const path = line.trim().replace(/^[0-9a-f]+:/, '');
    const m = /(?:^|\/)src\/(?:test|it|integrationTest)\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(path);
    if (m) classes.add(m[1]!.replace(/\//g, '.'));
  }
  return classes;
}

/** Latest L2 baseline per target for a repo, from the onboarding runs. */
export async function envParity(rt: Runtime, repo: string): Promise<ParityReport> {
  const latest: Record<'host' | 'cell', { run: string; report: VerifyReport } | null> = { host: null, cell: null };
  const runs = rt.events.runs().filter((r) => r.startsWith(`onboard-${repo}-`)).sort().reverse();
  for (const run of runs) {
    const v = rt.events.list(run).filter((e) => e.type === 'ENV_VERIFIED').at(-1)?.payload as { target?: 'host' | 'cell'; report?: string } | undefined;
    if (!v?.report) continue;
    const target = v.target ?? 'host';
    if (latest[target]) continue;
    latest[target] = { run, report: JSON.parse(rt.artifacts.read(v.report).toString('utf8')) as VerifyReport };
  }
  const side = (x: { run: string; report: VerifyReport } | null) => (x?.report.baseline ? { run: x.run, level: x.report.level, summary: x.report.baseline.summary } : null);
  const result: ParityReport = { host: side(latest.host), cell: side(latest.cell), differences: [], onlyOnHost: [], onlyInCell: [], needsContainerRuntime: [], ok: false, notes: [] };
  if (!latest.host?.report.baseline || !latest.cell?.report.baseline) {
    result.notes.push(`need an L2 baseline on both targets: run \`gatehouse env verify ${repo} --target host\` and \`--target cell\``);
    return result;
  }
  const sha = String((rt.events.list(latest.cell.run).find((e) => e.type === 'RUN_STARTED')?.payload as { sha?: string } | undefined)?.sha ?? '');
  const record = rt.repos.get(repo);
  const containers = record && sha ? await containerTestClasses(record.mirror, sha) : new Set<string>();
  Object.assign(result, compareBaselines(latest.host.report.baseline, latest.cell.report.baseline, containers));
  if (result.needsContainerRuntime.length) {
    result.notes.push(`${result.needsContainerRuntime.length} test(s) start containers; they run on host only unless the cell runtime provides Docker (Sysbox/Kata). Repro tests that need them come out INCONCLUSIVE.`);
  }
  result.ok = result.differences.length === 0 && result.onlyOnHost.length === 0 && result.onlyInCell.length === 0;
  return result;
}

// ---- B4: readiness of this machine for sandbox cells ------------------------------------------

export interface ReadinessCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

const clean = (s: string) => s.replace(/\0/g, '').trim();

/** What Version B needs on this machine, with the fix for each gap. Read-only: changes nothing. */
export async function bootstrapCheck(rt: Runtime): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);
  const c = rt.config.cell;
  const parallel = rt.config.scheduler.maxParallelRuns;

  const docker = await run(['docker', 'version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
  if (docker.error || docker.code !== 0) {
    add({ name: 'docker', status: 'fail', detail: docker.error ? 'docker CLI not found' : 'Docker daemon is not running', fix: 'Install Docker Desktop (Windows/macOS) or Docker Engine (Linux) and start it' });
    return checks;
  }
  add({ name: 'docker', status: 'ok', detail: `Docker Engine ${clean(docker.stdout)}` });

  const cell = new CellTarget({ host: rt.host, config: rt.config, artifacts: rt.artifacts, events: rt.events, repos: rt.repos });
  const avail = await cell.available();
  add(
    avail.ok
      ? { name: 'cell runtime', status: c.runtime === 'runc' ? 'warn' : 'ok', detail: `cell.runtime=${c.runtime} (Docker has: ${avail.runtimes.join(', ')})`, fix: c.runtime === 'runc' ? 'runc shares the host kernel. For stronger isolation install gVisor (runsc) in the WSL/Linux Docker engine and set cell.runtime: runsc' : undefined }
      : { name: 'cell runtime', status: 'fail', detail: avail.reason ?? 'unavailable', fix: `Install ${c.runtime} and register it with Docker, or set cell.runtime: runc in config.local.yaml` },
  );

  if (process.platform === 'win32') {
    const wslEnv = { ...process.env, WSL_UTF8: '1' };
    const ver = await run(['wsl', '--version'], { timeoutMs: 30_000, env: wslEnv });
    add(ver.code === 0 ? { name: 'WSL', status: 'ok', detail: clean(ver.stdout).split('\n')[0]! } : { name: 'WSL', status: 'fail', detail: 'WSL 2 not available', fix: 'wsl --install (needs admin and a reboot)' });
    const distros = await run(['wsl', '-l', '-q'], { timeoutMs: 30_000, env: wslEnv });
    const names = clean(distros.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const userDistro = names.filter((n) => !n.startsWith('docker-desktop'));
    add(
      userDistro.length
        ? { name: 'WSL distro', status: 'ok', detail: userDistro.join(', ') }
        : { name: 'WSL distro', status: 'warn', detail: `only ${names.join(', ') || 'none'}`, fix: 'Optional: `wsl --install -d Ubuntu` to run Gatehouse inside Linux (faster file I/O for builds, gVisor support)' },
    );
    if (c.runtime === 'kata') {
      const kvm = await run(['wsl', '-d', 'docker-desktop', '-e', 'sh', '-c', 'test -e /dev/kvm && echo yes'], { timeoutMs: 30_000, env: wslEnv });
      add(clean(kvm.stdout) === 'yes' ? { name: '/dev/kvm', status: 'ok', detail: 'nested virtualization available for Kata' } : { name: '/dev/kvm', status: 'fail', detail: 'no /dev/kvm in WSL', fix: 'Enable nestedVirtualization=true under [wsl2] in ~/.wslconfig, then `wsl --shutdown`' });
    }
    const wslconfig = join(homedir(), '.wslconfig');
    const text = existsSync(wslconfig) ? readFileSync(wslconfig, 'utf8') : '';
    const mem = /^\s*memory\s*=\s*(\d+)\s*GB/im.exec(text)?.[1];
    const need = c.memoryGb * parallel + 2;
    if (!mem) add({ name: '.wslconfig', status: 'warn', detail: 'no memory limit set (WSL takes up to half of RAM)', fix: `Add under [wsl2]: memory=${need}GB and processors=${Math.min(cpus().length, c.cpus * parallel)}` });
    else add({ name: '.wslconfig', status: Number(mem) >= need ? 'ok' : 'warn', detail: `memory=${mem}GB`, fix: Number(mem) >= need ? undefined : `${parallel} parallel cells × ${c.memoryGb} GB need about ${need} GB; raise memory or lower scheduler.maxParallelRuns` });
  }

  const ramGb = Math.round(totalmem() / 2 ** 30);
  const cpuCount = cpus().length;
  const needRam = c.memoryGb * parallel;
  add({
    name: 'capacity',
    status: needRam <= ramGb * 0.6 && c.cpus * parallel <= cpuCount ? 'ok' : 'warn',
    detail: `${parallel} parallel cell(s) × (${c.cpus} CPU, ${c.memoryGb} GB) on ${cpuCount} threads / ${ramGb} GB`,
    fix: needRam > ramGb * 0.6 || c.cpus * parallel > cpuCount ? 'Lower scheduler.maxParallelRuns or cell.memoryGb/cell.cpus' : undefined,
  });

  for (const repo of rt.repos.list()) {
    const env = latestEnv(rt.events, rt.artifacts, repo.name);
    if (!env.spec) {
      add({ name: `repo ${repo.name}`, status: 'warn', detail: 'no environment spec yet', fix: `gatehouse env verify ${repo.name} --target cell` });
      continue;
    }
    const image = imageFor(env.spec);
    const img = await run(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 30_000 });
    const vol = await run(['docker', 'volume', 'inspect', cacheVolume(repo.name), '--format', '{{.Name}}'], { timeoutMs: 30_000 });
    const parts = [`image ${image} ${img.code === 0 ? 'present' : 'not pulled yet'}`, `cache ${vol.code === 0 ? 'warm' : 'empty'}`];
    add({
      name: `repo ${repo.name}`,
      status: img.code === 0 && vol.code === 0 ? 'ok' : 'warn',
      detail: parts.join(', '),
      fix: img.code === 0 && vol.code === 0 ? undefined : `gatehouse env verify ${repo.name} --target cell (pulls the image and warms the cache once, with network)`,
    });
  }
  return checks;
}
