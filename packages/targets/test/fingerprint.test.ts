import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprintNotes, javaMajor, parseJavaVersion, parseMavenVersion } from '../src/index.ts';

const MVN_WINDOWS = `Apache Maven 3.9.9 (8e8579a9e76f7d015ee5ec7bfcdc97d260186937)
Maven home: D:\\Tools\\apache-maven-3.9.9-bin\\apache-maven-3.9.9
Java version: 21.0.11, vendor: Eclipse Adoptium, runtime: D:\\Personal\\tools\\jdk-21.0.11+10
Default locale: en_US, platform encoding: UTF-8
OS name: "windows 11", version: "10.0", arch: "amd64", family: "windows"`;

const JAVA_11 = `openjdk version "11.0.31" 2026-04-21
OpenJDK Runtime Environment Temurin-11.0.31+11 (build 11.0.31+11)
OpenJDK 64-Bit Server VM Temurin-11.0.31+11 (build 11.0.31+11, mixed mode)`;

test('parses mvn -v including the JDK Maven really runs on', () => {
  const p = parseMavenVersion(MVN_WINDOWS);
  assert.equal(p.version, '3.9.9');
  assert.equal(p.detail?.javaVersion, '21.0.11');
  assert.equal(p.detail?.javaVendor, 'Eclipse Adoptium');
  assert.equal(p.detail?.javaRuntime, 'D:\\Personal\\tools\\jdk-21.0.11+10');
});

test('parses java -version', () => {
  const p = parseJavaVersion(JAVA_11);
  assert.equal(p.version, '11.0.31');
  assert.match(p.detail?.runtime ?? '', /Temurin-11/);
});

test('javaMajor handles legacy and modern schemes', () => {
  assert.equal(javaMajor('1.8.0_392'), 8);
  assert.equal(javaMajor('11.0.31'), 11);
  assert.equal(javaMajor('21'), 21);
  assert.equal(javaMajor(undefined), undefined);
});

test('flags a JDK mismatch between PATH java and Maven', () => {
  const notes = fingerprintNotes(
    {
      java: { name: 'java', found: true, version: '11.0.31' },
      mvn: { name: 'mvn', found: true, version: '3.9.9', detail: { javaVersion: '21.0.11' } },
      copilot: { name: 'copilot', found: true, version: '1.0.88' },
    },
    { HOME: '/nonexistent-home-for-test', USERPROFILE: '/nonexistent-home-for-test' },
  );
  assert.ok(notes.some((n) => n.includes('Maven runs on JDK 21') && n.includes('JDK 11')));
});
