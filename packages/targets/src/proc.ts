import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import crossSpawn from 'cross-spawn';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Per-stream cap on captured output; the process keeps running, extra output is dropped. */
  maxOutputBytes?: number;
  /** Written to stdin, then stdin is closed. Use this for secrets and long prompts, never argv. */
  input?: string;
}

export interface RunResult {
  argv: string[];
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** Spawn failure such as ENOENT; the command never ran. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

/**
 * Runs argv without a shell. On Windows, cross-spawn wraps .cmd/.bat shims (mvn.cmd, npm shims)
 * in `cmd.exe /d /s /c` with escaped arguments, which plain spawn refuses since CVE-2024-27980.
 */
export function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const [command, ...args] = argv;
  if (!command) throw new Error('run: empty argv');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = crossSpawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so a timeout can kill the whole tree.
      detached: process.platform !== 'win32',
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // process may exit before reading everything
      child.stdin.end(options.input, 'utf8');
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    child.stdout?.on('data', (b: Buffer) => {
      if (outBytes < maxOutput) out.push(b);
      else truncated = true;
      outBytes += b.length;
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (errBytes < maxOutput) err.push(b);
      else truncated = true;
      errBytes += b.length;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    let spawnError: string | undefined;
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e.code ?? e.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        argv,
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
        truncated,
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** PATH (+ PATHEXT on Windows) lookup; returns the file the OS would execute, or null. */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  const windows = process.platform === 'win32';
  const exts = windows ? (getEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidates = (base: string) =>
    windows && !extname(base) ? exts.map((e) => base + e.toLowerCase()) : [base];

  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return candidates(name).find(isFile) ?? null;
  }
  for (const dir of (getEnv(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
    const hit = candidates(join(dir, name)).find(isFile);
    if (hit) return hit;
  }
  return null;
}

/** Case-insensitive env read (Windows env keys keep their original casing, e.g. `Path`). */
export function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}
