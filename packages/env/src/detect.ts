import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode, type YAMLMap } from 'yaml';
import type { Fact } from './spec.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', '.gradle', '.idea', '.vscode']);
const MAX_FILES = 20_000;

/**
 * Deterministic scan of a checkout. No LLM, no execution: only reads files and records each
 * observation with a file:line citation. Order of trust is decided later in synthesize().
 */
export function detectFacts(root: string): Fact[] {
  const files = listFiles(root);
  const rel = (p: string) => relative(root, p).split(sep).join('/');
  const facts: Fact[] = [];
  const push = (key: string, value: Fact['value'], file: string, line: number) =>
    facts.push({ key, value, source: `${rel(file)}:${line}` });

  for (const file of files.filter((f) => /[\\/]\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/.test(f))) {
    scanGithubWorkflow(file, push);
  }
  for (const name of ['.java-version', '.nvmrc', '.node-version', '.sdkmanrc', '.tool-versions']) {
    const file = join(root, name);
    if (existsSync(file)) scanPinFile(file, name, push);
  }
  const rootPom = join(root, 'pom.xml');
  for (const pom of files.filter((f) => f.endsWith(`${sep}pom.xml`) || f === rootPom)) scanPom(pom, pom === rootPom, push);
  const wrapper = join(root, '.mvn', 'wrapper', 'maven-wrapper.properties');
  if (existsSync(wrapper)) scanMavenWrapper(wrapper, push);
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) scanPackageJson(root, pkg, push);
  for (const file of files.filter((f) => /[\\/]src[\\/]test[\\/]resources[\\/]application[\w-]*\.(ya?ml|properties)$/.test(f))) {
    scanTestDatasource(file, push);
  }
  for (const file of files.filter((f) => /(^|[\\/])(docker-)?compose[\w.-]*\.ya?ml$/.test(f) && !f.includes(`${sep}.github${sep}`))) {
    scanCompose(file, push);
  }
  const devcontainer = join(root, '.devcontainer', 'devcontainer.json');
  if (existsSync(devcontainer)) scanDevcontainer(devcontainer, push);
  return facts;
}

type Push = (key: string, value: Fact['value'], file: string, line: number) => void;

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= MAX_FILES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length;
}

function scanGithubWorkflow(file: string, push: Push): void {
  const text = readFileSync(file, 'utf8');
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const line = (node: YamlNode | null | undefined) => (node?.range ? lc.linePos(node.range[0]).line : 1);
  const jobs = doc.get('jobs', true);
  if (!isMap(jobs)) return;

  for (const jobPair of jobs.items) {
    const job = jobPair.value;
    if (!isMap(job)) continue;
    const matrix = job.getIn(['strategy', 'matrix'], true);

    const services = job.get('services', true);
    if (isMap(services)) {
      for (const svc of services.items) {
        const name = isScalar(svc.key) ? String(svc.key.value) : 'service';
        const imageNode = isMap(svc.value) ? svc.value.get('image', true) : svc.value;
        if (isScalar(imageNode)) push('ci.service', { name, image: String(imageNode.value) }, file, line(imageNode));
      }
    }

    const steps = job.get('steps', true);
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      const uses = scalarString(step.get('uses', true));
      const withMap = step.get('with', true);
      if (uses?.startsWith('actions/setup-java') && isMap(withMap)) {
        for (const v of versionsFrom(withMap.get('java-version', true), matrix)) push('jdk.ci', v.value, file, line(v.node));
        const dist = withMap.get('distribution', true);
        if (isScalar(dist)) push('jdk.distribution.ci', String(dist.value), file, line(dist));
      }
      if (uses?.startsWith('actions/setup-node') && isMap(withMap)) {
        for (const v of versionsFrom(withMap.get('node-version', true), matrix)) push('node.ci', v.value, file, line(v.node));
      }
      const runNode = step.get('run', true);
      const runText = scalarString(runNode);
      if (runText && isScalar(runNode)) {
        // Block scalars (`run: |`) start their content on the line after the indicator.
        const indicator = runNode.range ? text[runNode.range[0]] : '';
        const first = line(runNode) + (indicator === '|' || indicator === '>' ? 1 : 0);
        for (const [i, cmd] of runText.split('\n').entries()) {
          if (/(^|\s)(\.\/)?(mvnw?|mvn\.cmd|mvnw\.cmd)\b|\bnpm (run )?test\b|\bnpx (jest|vitest)\b/.test(cmd)) {
            push('ci.command', cmd.trim(), file, first + i);
          }
        }
      }
    }
  }
}

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && node.value !== null && node.value !== undefined ? String(node.value) : undefined;
}

/** Resolves `${{ matrix.java }}` against the job matrix; returns one entry per concrete version. */
function versionsFrom(node: unknown, matrix: unknown): Array<{ value: string; node: YamlNode }> {
  if (!isScalar(node)) return [];
  const raw = String(node.value);
  const ref = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(raw);
  if (ref && isMap(matrix)) {
    const list = (matrix as YAMLMap).get(ref[1]!, true);
    if (isSeq(list)) return list.items.filter(isScalar).map((n) => ({ value: String(n.value), node: n }));
    if (isScalar(list)) return [{ value: String(list.value), node: list }];
  }
  return ref ? [] : [{ value: raw, node }];
}

function scanPinFile(file: string, name: string, push: Push): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;
    if (name === '.java-version') push('jdk.pin', text, file, i + 1);
    else if (name === '.nvmrc' || name === '.node-version') push('node.pin', text.replace(/^v/, ''), file, i + 1);
    else if (name === '.sdkmanrc') {
      const m = /^java=([\d.]+)/.exec(text);
      if (m) push('jdk.pin', m[1]!, file, i + 1);
    } else if (name === '.tool-versions') {
      const m = /^(java|nodejs)\s+(\S+)/.exec(text);
      if (m) push(m[1] === 'java' ? 'jdk.pin' : 'node.pin', m[2]!.replace(/^[a-z]+-/, ''), file, i + 1);
    }
  });
}

function scanPom(file: string, isRoot: boolean, push: Push): void {
  const text = readFileSync(file, 'utf8');
  const props = new Map<string, string>();
  const propsBlock = /<properties>([\s\S]*?)<\/properties>/.exec(text);
  if (propsBlock) {
    for (const m of propsBlock[1]!.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) props.set(m[1]!, m[2]!.trim());
  }
  const resolveProp = (v: string) => v.replace(/\$\{([\w.-]+)\}/g, (_, k: string) => props.get(k) ?? `\${${k}}`);

  const releasePatterns: Array<[RegExp, string]> = [
    [/<maven\.compiler\.release>([^<]+)</g, 'maven.compiler.release'],
    [/<java\.version>([^<]+)</g, 'java.version'],
    [/<maven\.compiler\.source>([^<]+)</g, 'maven.compiler.source'],
    [/<release>([^<]+)<\/release>/g, 'compiler release'],
  ];
  for (const [re, label] of releasePatterns) {
    for (const m of text.matchAll(re)) {
      const value = resolveProp(m[1]!.trim());
      if (/^\d+(\.\d+)*$/.test(value)) push('jdk.release', { version: value, via: label }, file, lineOf(text, m.index));
    }
  }
  if (isRoot) push('build.maven', 'pom.xml', file, 1);
  if (isRoot && /<modules>/.test(text)) push('maven.multimodule', true, file, lineOf(text, text.indexOf('<modules>')));
  for (const plugin of ['maven-surefire-plugin', 'maven-failsafe-plugin', 'jacoco-maven-plugin']) {
    const at = text.indexOf(`<artifactId>${plugin}</artifactId>`);
    if (at >= 0) push('maven.plugin', plugin, file, lineOf(text, at));
  }
  const tc = text.indexOf('<groupId>org.testcontainers</groupId>');
  if (tc >= 0) push('dep.testcontainers', true, file, lineOf(text, tc));
}

function scanMavenWrapper(file: string, push: Push): void {
  const text = readFileSync(file, 'utf8');
  const m = /distributionUrl=.*apache-maven-([\d.]+)-bin/.exec(text);
  push('maven.wrapper', m ? m[1]! : 'present', file, m ? lineOf(text, m.index) : 1);
}

function scanPackageJson(root: string, file: string, push: Push): void {
  const text = readFileSync(file, 'utf8');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const at = (needle: string) => lineOf(text, text.indexOf(needle));
  push('build.npm', 'package.json', file, 1);
  const engines = pkg.engines as Record<string, string> | undefined;
  if (engines?.node) push('node.engines', engines.node, file, at('"node"'));
  if (typeof pkg.packageManager === 'string') push('node.packageManager', pkg.packageManager, file, at('"packageManager"'));
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts?.test) push('node.testScript', scripts.test, file, at('"test"'));
  if (scripts?.build) push('node.buildScript', scripts.build, file, at('"build"'));
  const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
  for (const runner of ['vitest', 'jest', 'mocha']) {
    if (deps[runner]) {
      push('node.testRunner', runner, file, at(`"${runner}"`));
      break;
    }
  }
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    if (existsSync(join(root, lock))) push('node.lockfile', lock, join(root, lock), 1);
  }
}

function scanTestDatasource(file: string, push: Push): void {
  const text = readFileSync(file, 'utf8');
  const m = /jdbc:(postgresql|mysql|mariadb|sqlserver|oracle|h2|tc:[a-z]+)/.exec(text);
  if (m) push('test.datasource', m[1]!, file, lineOf(text, m.index));
}

function scanCompose(file: string, push: Push): void {
  const text = readFileSync(file, 'utf8');
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const services = doc.get('services', true);
  if (!isMap(services)) return;
  for (const svc of services.items) {
    const image = isMap(svc.value) ? svc.value.get('image', true) : undefined;
    if (isScalar(image) && isScalar(svc.key)) {
      push('compose.service', { name: String(svc.key.value), image: String(image.value) }, file, image.range ? lc.linePos(image.range[0]).line : 1);
    }
  }
}

function scanDevcontainer(file: string, push: Push): void {
  const text = readFileSync(file, 'utf8');
  const m = /"image"\s*:\s*"([^"]+)"/.exec(text);
  if (m) push('devcontainer.image', m[1]!, file, lineOf(text, m.index));
}

export function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}
