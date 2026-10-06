import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostTarget, createMirror, git, resolveCommit } from '../src/index.ts';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

test('prepares an isolated clone from the mirror, runs scrubbed commands, and cleans up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-host-'));
  try {
    const src = join(root, 'src');
    mkdirSync(src);
    await git(['init', '-q', '-b', 'main'], { cwd: src });
    writeFileSync(join(src, 'README.md'), 'v1\n');
    await git(['add', '.'], { cwd: src });
    await git(['commit', '-q', '-m', 'one'], { cwd: src, env: gitEnv });
    writeFileSync(join(src, 'README.md'), 'v2\n');
    await git(['commit', '-qam', 'two'], { cwd: src, env: gitEnv });

    const mirror = join(root, 'mirrors', 'demo.git');
    await createMirror(src, mirror);
    const first = await resolveCommit(mirror, 'main~1');

    const target = new HostTarget({
      runsDir: join(root, 'runs'),
      mirrorFor: () => mirror,
      baseEnv: { ...process.env, GITHUB_TOKEN: 'ghp_should_not_leak' },
    });
    const ws = await target.prepare({ runId: 'run-1', repo: 'demo', sha: first });
    assert.equal(readFileSync(join(ws.dir, 'README.md'), 'utf8').trim(), 'v1', 'worktree is pinned to the requested commit');

    const r = await target.exec(ws, [process.execPath, '-e', 'process.stdout.write(String(process.env.GITHUB_TOKEN) + "|" + process.cwd())']);
    const [token, cwd] = r.stdout.split('|');
    assert.equal(token, 'undefined');
    assert.equal(cwd?.toLowerCase(), ws.dir.toLowerCase());

    await assert.rejects(target.exec(ws, ['./../../escape']), /outside the workspace/);
    await assert.rejects(target.prepare({ runId: 'run-1', repo: 'demo', sha: first }), /already exists/);

    assert.equal(await git(['remote'], { cwd: ws.dir }), '', 'workspace has no remote to push to');
    assert.ok(statSync(join(ws.dir, '.git')).isDirectory(), 'a real .git dir, readable by JGit-based plugins');

    await target.destroy(ws);
    assert.equal(existsSync(ws.dir), false);
    const evidence = await target.prepare({ runId: 'run-1', repo: 'demo', sha: first, slot: 'evidence' });
    assert.notEqual(evidence.dir, ws.dir);
    await target.destroy(evidence);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
