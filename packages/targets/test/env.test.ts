import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEnv } from '../src/index.ts';

test('keeps toolchain and OS variables, drops credentials and unknowns', () => {
  const { env, dropped } = scrubEnv({
    Path: 'C:\\bin',
    USERPROFILE: 'C:\\Users\\me',
    JAVA_HOME: 'D:\\jdk-21',
    MAVEN_OPTS: '-Xmx1g',
    LC_ALL: 'C.UTF-8',
    GITHUB_TOKEN: 'ghp_x',
    COPILOT_GITHUB_TOKEN: 'github_pat_x',
    OPENAI_API_KEY: 'sk-x',
    JIRA_PAT: 'x',
    MY_SERVICE_PASSWORD: 'x',
    NODE_OPTIONS: '--require evil.js',
    RANDOM_THING: 'x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['JAVA_HOME', 'LC_ALL', 'MAVEN_OPTS', 'Path', 'USERPROFILE']);
  for (const secret of ['GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'OPENAI_API_KEY', 'JIRA_PAT', 'MY_SERVICE_PASSWORD', 'NODE_OPTIONS']) {
    assert.ok(dropped.includes(secret), `${secret} should be dropped`);
  }
});

test('the deny pattern wins even for allowlist-shaped names', () => {
  const { env } = scrubEnv({ JAVA_HOME_TOKEN: 'x', LC_SECRET: 'x' });
  assert.deepEqual(env, {});
});

test('Gatehouse-provided extras are added after scrubbing', () => {
  const { env } = scrubEnv({ PATH: '/bin', GATEHOUSE_HOME: '/x' }, { CODEX_HOME: '/run/codex' });
  assert.deepEqual(env, { PATH: '/bin', CODEX_HOME: '/run/codex' });
});
