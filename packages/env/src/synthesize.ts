import type { HostFingerprint } from '@gatehouse/targets';
import { javaMajor } from '@gatehouse/targets';
import type { Command, EnvSpec, Fact, Provenance, ServiceNeed, Stack } from './spec.ts';

export interface SynthesizeInput {
  repo: string;
  derivedFrom: { ref: string; sha: string };
  target: 'host' | 'cell';
  facts: Fact[];
  /** Host measurement; only meaningful when target is 'host'. */
  fingerprint?: HostFingerprint;
}

const src = (f: Fact): Provenance => ({ kind: 'SOURCE', ref: f.source });
const fileOf = (f: Fact) => f.source.replace(/:\d+$/, '');
const majorOf = (v: string) => javaMajor(v.replace(/^[^\d]*/, ''));
const JACOCO = '0.8.12';
const DB_IMAGES: Record<string, string> = { postgresql: 'postgres', mysql: 'mysql', mariadb: 'mariadb', sqlserver: 'mcr.microsoft.com/mssql/server', oracle: 'gvenzl/oracle-free' };

/**
 * Rule-based mapping from facts to an EnvSpec. Precedence for toolchain versions:
 * CI (what demonstrably runs) > pin files > build manifest minimum, with conflicts reported
 * as warnings rather than silently resolved. No LLM here; gaps stay visible as INFERRED.
 */
export function synthesize(input: SynthesizeInput): EnvSpec {
  const { facts, fingerprint } = input;
  const all = (key: string) => facts.filter((f) => f.key === key);
  const first = (key: string) => all(key)[0];
  const warnings: string[] = [];

  const stack: Stack = first('build.maven') ? 'java-maven' : first('build.npm') ? 'node' : 'unknown';
  const spec: EnvSpec = {
    specVersion: 1,
    repo: input.repo,
    derivedFrom: input.derivedFrom,
    target: input.target,
    stack,
    toolchain: {},
    services: [],
    commands: {},
    needs: { containerRuntime: false },
    warnings,
  };

  if (stack === 'java-maven') javaMaven(spec, all, first, fingerprint, warnings);
  else if (stack === 'node') node(spec, all, first, fingerprint, warnings);
  else warnings.push('No supported build file found (pom.xml or package.json); only static review (L0) is possible.');

  spec.services = services(all, warnings);
  const tc = first('dep.testcontainers') ?? all('test.datasource').find((f) => String(f.value).startsWith('tc:'));
  if (tc) {
    spec.needs.containerRuntime = true;
    warnings.push(`Tests use Testcontainers (${tc.source}); they need a container runtime${input.target === 'host' ? ' on this host (Docker Desktop must be running)' : ' (Kata cell)'}.`);
  }
  if (input.target === 'host' && spec.services.length) {
    warnings.push(`Host mode does not start services; tests needing ${spec.services.map((s) => s.name).join(', ')} pass only if they are already running locally.`);
  }
  return spec;
}

type All = (key: string) => Fact[];
type First = (key: string) => Fact | undefined;

function javaMaven(spec: EnvSpec, all: All, first: First, fp: HostFingerprint | undefined, warnings: string[]): void {
  const releases = all('jdk.release').map((f) => ({ f, major: majorOf(String((f.value as { version: string }).version)) }));
  const minimum = releases.filter((r) => r.major !== undefined).sort((a, b) => b.major! - a.major!)[0];
  // Repos often carry several workflows (e.g. Maven and Gradle); trust the ones that actually run Maven.
  const mavenWorkflows = new Set(all('ci.command').filter((f) => /\bmvnw?\b/.test(String(f.value))).map((f) => fileOf(f)));
  const ciFacts = all('jdk.ci').filter((f) => !mavenWorkflows.size || mavenWorkflows.has(fileOf(f)));
  const ci = ciFacts.map((f) => ({ f, major: majorOf(String(f.value)) })).filter((c) => c.major !== undefined);
  const pin = first('jdk.pin');

  let requirement: { major: number; provenance: Provenance } | undefined;
  const ciOk = ci.filter((c) => !minimum || c.major! >= minimum.major!).sort((a, b) => b.major! - a.major!)[0];
  if (ciOk) requirement = { major: ciOk.major!, provenance: src(ciOk.f) };
  else if (pin && majorOf(String(pin.value))) requirement = { major: majorOf(String(pin.value))!, provenance: src(pin) };
  else if (minimum) requirement = { major: minimum.major!, provenance: src(minimum.f) };

  if (ci.length && minimum && !ciOk) {
    warnings.push(`CI uses JDK ${ci.map((c) => c.major).join('/')} but the build requires at least ${minimum.major} (${minimum.f.source}).`);
  }
  const measured = fp?.tools.mvn?.detail?.javaVersion;
  spec.toolchain.jdk = {
    ...(requirement ? { requirement: String(requirement.major) } : {}),
    ...(measured ? { measured } : {}),
    provenance: requirement?.provenance ?? { kind: 'INFERRED', reason: 'no JDK version declared in CI, pin files or pom.xml' },
  };
  const measuredMajor = javaMajor(measured);
  if (requirement && measuredMajor !== undefined && measuredMajor < requirement.major) {
    warnings.push(`Host Maven runs on JDK ${measuredMajor} but the repo needs JDK ${requirement.major}; the build will likely fail until a matching JDK is configured.`);
  }

  const wrapper = first('maven.wrapper');
  spec.toolchain.maven = {
    ...(wrapper && wrapper.value !== 'present' ? { requirement: String(wrapper.value) } : {}),
    ...(!wrapper && fp?.tools.mvn?.version ? { measured: fp.tools.mvn.version } : {}),
    provenance: wrapper ? src(wrapper) : fp?.tools.mvn?.version ? { kind: 'HOST', ref: 'mvn -v' } : { kind: 'INFERRED', reason: 'Maven not found on host and no wrapper in repo' },
  };
  if (!wrapper && !fp?.tools.mvn?.found) warnings.push('Neither a Maven wrapper (mvnw) nor mvn on PATH is available.');

  const exe = wrapper ? './mvnw' : 'mvn';
  const ciCmd = all('ci.command').find((f) => /\bmvnw?\b/.test(String(f.value)));
  const cmdProv: Provenance = ciCmd ? src(ciCmd) : { kind: 'INFERRED', reason: 'standard Maven lifecycle' };
  const cmd = (argv: string[]): Command => ({ argv: [exe, '-B', '-ntp', ...argv], provenance: cmdProv });
  spec.commands = {
    build: cmd(['-DskipTests', 'test-compile']),
    testAll: cmd(['-fae', 'test']),
    testOne: cmd(['test', '-Dtest={class}', '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false']),
    // Pinned JaCoCo coordinates so coverage works even where the pom does not configure it.
    coverage: cmd(['-fae', '-Dmaven.test.failure.ignore=true', `org.jacoco:jacoco-maven-plugin:${JACOCO}:prepare-agent`, 'test', `org.jacoco:jacoco-maven-plugin:${JACOCO}:report`]),
  };
  if (first('maven.multimodule')) warnings.push('Multi-module build: test_one runs across all modules with unmatched modules skipped.');
}

function node(spec: EnvSpec, all: All, first: First, fp: HostFingerprint | undefined, warnings: string[]): void {
  const declared = first('node.ci') ?? first('node.pin') ?? first('node.engines');
  spec.toolchain.node = {
    ...(declared ? { requirement: String(declared.value) } : {}),
    ...(fp?.tools.node?.version ? { measured: fp.tools.node.version } : {}),
    provenance: declared ? src(declared) : { kind: 'INFERRED', reason: 'no Node version declared' },
  };
  const pmFact = first('node.packageManager');
  const lock = first('node.lockfile');
  const pm = pmFact ? String(pmFact.value).split('@')[0]! : lock?.value === 'pnpm-lock.yaml' ? 'pnpm' : lock?.value === 'yarn.lock' ? 'yarn' : 'npm';
  const pmProv: Provenance = pmFact ? src(pmFact) : lock ? src(lock) : { kind: 'INFERRED', reason: 'default package manager' };
  spec.commands.setup = { argv: pm === 'npm' ? (lock ? ['npm', 'ci'] : ['npm', 'install']) : [pm, 'install', '--frozen-lockfile'], provenance: pmProv };
  const build = first('node.buildScript');
  if (build) spec.commands.build = { argv: [pm, 'run', 'build'], provenance: src(build) };
  const test = first('node.testScript');
  if (test) spec.commands.testAll = { argv: [pm, 'test'], provenance: src(test) };
  else warnings.push('package.json has no test script; L2 is not reachable.');
  const runner = first('node.testRunner');
  if (runner?.value === 'jest') spec.commands.testOne = { argv: ['npx', 'jest', '{file}'], provenance: src(runner) };
  if (runner?.value === 'vitest') spec.commands.testOne = { argv: ['npx', 'vitest', 'run', '{file}'], provenance: src(runner) };
}

function services(all: All, warnings: string[]): ServiceNeed[] {
  const out: ServiceNeed[] = [];
  const seen = new Set<string>();
  const add = (s: ServiceNeed) => {
    const key = (s.image ?? s.kind).split(':')[0]!;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  };
  for (const f of [...all('ci.service'), ...all('compose.service')]) {
    const v = f.value as { name: string; image: string };
    add({ name: v.name, kind: kindOf(v.image), image: v.image, provenance: src(f) });
  }
  for (const f of all('test.datasource')) {
    const db = String(f.value);
    if (db === 'h2' || db.startsWith('tc:')) continue;
    const image = DB_IMAGES[db];
    if (image && !seen.has(image)) {
      add({ name: db, kind: 'database', image, provenance: { kind: 'INFERRED', reason: `test datasource is ${db} (${f.source}) but no service declares it` } });
      warnings.push(`Test config points at ${db} (${f.source}) without a CI/compose service; the image was inferred.`);
    }
  }
  return out;
}

function kindOf(image: string): string {
  if (/postgres|mysql|mariadb|mssql|oracle|mongo/.test(image)) return 'database';
  if (/redis|memcached/.test(image)) return 'cache';
  if (/kafka|rabbitmq|activemq|nats/.test(image)) return 'broker';
  return 'service';
}
