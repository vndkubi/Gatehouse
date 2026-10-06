import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gh-env-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

export const CI_WORKFLOW = `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        java: [17, 21]
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: \${{ matrix.java }}
      - name: Build
        run: |
          echo start
          ./mvnw -B verify
`;

export const POM = `<project>
  <modelVersion>4.0.0</modelVersion>
  <properties>
    <java.version>21</java.version>
  </properties>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration><release>\${java.version}</release></configuration>
      </plugin>
      <plugin>
        <artifactId>maven-surefire-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
  <dependencies>
    <dependency>
      <groupId>org.testcontainers</groupId>
      <artifactId>postgresql</artifactId>
    </dependency>
  </dependencies>
</project>
`;

export const SUREFIRE_XML = (className: string, cases: Array<[string, 'pass' | 'fail' | 'skip']>) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${className}" tests="${cases.length}">
${cases
  .map(([name, s]) =>
    s === 'pass'
      ? `  <testcase name="${name}" classname="${className}" time="0.01"/>`
      : s === 'fail'
        ? `  <testcase name="${name}" classname="${className}" time="0.01"><failure message="boom">trace</failure></testcase>`
        : `  <testcase name="${name}" classname="${className}" time="0"><skipped/></testcase>`,
  )
  .join('\n')}
</testsuite>
`;
