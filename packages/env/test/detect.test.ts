import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import type { HostFingerprint } from '@gatehouse/targets';
import { detectFacts, synthesize, type Fact } from '../src/index.ts';
import { CI_WORKFLOW, POM, makeRepo } from './fixtures.ts';

const find = (facts: Fact[], key: string) => facts.filter((f) => f.key === key);

test('detects CI matrix, services, commands, pom release, wrapper and Testcontainers with citations', () => {
  const root = makeRepo({
    '.github/workflows/ci.yml': CI_WORKFLOW,
    'pom.xml': POM,
    '.mvn/wrapper/maven-wrapper.properties': 'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.zip\n',
    'src/test/resources/application-test.yml': 'spring:\n  datasource:\n    url: jdbc:postgresql://localhost:5432/app\n',
    'node_modules/ignored/pom.xml': '<project><modules></modules></project>',
  });
  try {
    const facts = detectFacts(root);
    assert.deepEqual(find(facts, 'jdk.ci').map((f) => [f.value, f.source]), [
      ['17', '.github/workflows/ci.yml:8'],
      ['21', '.github/workflows/ci.yml:8'],
    ]);
    assert.deepEqual(find(facts, 'ci.service').map((f) => [f.value, f.source]), [[{ name: 'postgres', image: 'postgres:15' }, '.github/workflows/ci.yml:11']]);
    assert.deepEqual(find(facts, 'ci.command').map((f) => [f.value, f.source]), [['./mvnw -B verify', '.github/workflows/ci.yml:23']]);
    assert.deepEqual(find(facts, 'jdk.release').map((f) => (f.value as { version: string }).version), ['21', '21']);
    assert.equal(find(facts, 'maven.wrapper')[0]?.value, '3.9.6');
    assert.equal(find(facts, 'dep.testcontainers')[0]?.source, 'pom.xml:19');
    assert.equal(find(facts, 'test.datasource')[0]?.value, 'postgresql');
    assert.equal(find(facts, 'maven.multimodule').length, 0, 'node_modules must be ignored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const fingerprint = (mavenJdk: string): HostFingerprint => ({
  takenAt: '2026-10-06T00:00:00Z',
  os: { platform: 'win32', release: '10', arch: 'x64', cpus: 8, memoryGb: 23, wsl: false },
  tools: { mvn: { name: 'mvn', found: true, version: '3.9.9', detail: { javaVersion: mavenJdk } } },
  notes: [],
});

test('picks the highest CI JDK that satisfies the pom minimum and cites it', () => {
  const root = makeRepo({ '.github/workflows/ci.yml': CI_WORKFLOW, 'pom.xml': POM, '.mvn/wrapper/maven-wrapper.properties': 'distributionUrl=x/apache-maven-3.9.6-bin.zip' });
  try {
    const spec = synthesize({ repo: 'svc', derivedFrom: { ref: 'main', sha: 'abc' }, target: 'host', facts: detectFacts(root), fingerprint: fingerprint('21.0.11') });
    assert.equal(spec.stack, 'java-maven');
    assert.equal(spec.toolchain.jdk?.requirement, '21');
    assert.equal(spec.toolchain.jdk?.measured, '21.0.11');
    assert.deepEqual(spec.toolchain.jdk?.provenance, { kind: 'SOURCE', ref: '.github/workflows/ci.yml:8' });
    assert.equal(spec.toolchain.maven?.requirement, '3.9.6');
    assert.equal(spec.commands.build?.argv[0], './mvnw');
    assert.deepEqual(spec.commands.testOne?.argv.slice(3, 5), ['test', '-Dtest={class}']);
    assert.equal(spec.commands.build?.provenance.kind, 'SOURCE');
    assert.equal(spec.needs.containerRuntime, true);
    assert.equal(spec.services[0]?.image, 'postgres:15');
    assert.ok(spec.warnings.some((w) => w.includes('Host mode does not start services')));
    assert.ok(!spec.warnings.some((w) => w.includes('likely fail')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('warns when the host JDK is older than the repo needs, and when CI is below the pom minimum', () => {
  const root = makeRepo({
    '.github/workflows/ci.yml': CI_WORKFLOW.replace('java: [17, 21]', 'java: [17]'),
    'pom.xml': POM,
  });
  try {
    const spec = synthesize({ repo: 'svc', derivedFrom: { ref: 'main', sha: 'abc' }, target: 'host', facts: detectFacts(root), fingerprint: fingerprint('11.0.31') });
    assert.equal(spec.toolchain.jdk?.requirement, '21');
    assert.equal(spec.commands.build?.argv[0], 'mvn');
    assert.ok(spec.warnings.some((w) => w.includes('CI uses JDK 17 but the build requires at least 21')));
    assert.ok(spec.warnings.some((w) => w.includes('Host Maven runs on JDK 11 but the repo needs JDK 21')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('infers a database service from the test datasource when nothing declares one', () => {
  const root = makeRepo({ 'pom.xml': '<project></project>', 'src/test/resources/application.properties': 'spring.datasource.url=jdbc:mysql://db/app\n' });
  try {
    const spec = synthesize({ repo: 'svc', derivedFrom: { ref: 'main', sha: 'abc' }, target: 'cell', facts: detectFacts(root) });
    assert.equal(spec.services[0]?.image, 'mysql');
    assert.equal(spec.services[0]?.provenance.kind, 'INFERRED');
    assert.equal(spec.toolchain.jdk?.provenance.kind, 'INFERRED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node repos get install/test commands from lockfile and runner', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'web', engines: { node: '>=20' }, scripts: { test: 'vitest run', build: 'tsc' }, devDependencies: { vitest: '^2' } }, null, 2),
    'package-lock.json': '{}',
    '.nvmrc': 'v20.11.0\n',
  });
  try {
    const spec = synthesize({ repo: 'web', derivedFrom: { ref: 'main', sha: 'abc' }, target: 'host', facts: detectFacts(root) });
    assert.equal(spec.stack, 'node');
    assert.equal(spec.toolchain.node?.requirement, '20.11.0');
    assert.deepEqual(spec.commands.setup?.argv, ['npm', 'ci']);
    assert.deepEqual(spec.commands.testOne?.argv, ['npx', 'vitest', 'run', '{file}']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surefire failures keep their message so environment errors can be told apart', async () => {
  const { parseSurefireXml } = await import('../src/index.ts');
  const [r] = parseSurefireXml('<testsuite><testcase name="findAll" classname="app.DbIT"><error message="Could not find a valid Docker environment. Please see logs" type="java.lang.IllegalStateException">at org.testcontainers.DockerClientFactory</error></testcase></testsuite>');
  assert.equal(r!.status, 'failed');
  assert.match(r!.message!, /Could not find a valid Docker environment/);
});
