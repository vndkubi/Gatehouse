import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExecutable, run } from '@gatehouse/targets';

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type SecretBackend = 'dpapi' | 'secret-tool' | 'file';

/**
 * Machine-local secret store. Values go in and out over stdin/stdout of the OS tool, never
 * argv, and are never logged. Windows: DPAPI (CurrentUser) via PowerShell, so the files are
 * useless on another account or machine. Linux: libsecret's `secret-tool` when present,
 * otherwise a 0600 file.
 */
export class SecretStore {
  private readonly cache = new Map<string, string>();
  readonly backend: SecretBackend;

  constructor(private readonly dir: string, backend?: SecretBackend) {
    this.backend = backend ?? (process.platform === 'win32' ? 'dpapi' : resolveExecutable('secret-tool') ? 'secret-tool' : 'file');
  }

  async set(name: string, value: string): Promise<void> {
    assertName(name);
    if (!value) throw new Error('refusing to store an empty secret');
    mkdirSync(this.dir, { recursive: true });
    if (this.backend === 'dpapi') {
      const r = await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_PROTECT], { input: value, timeoutMs: 30_000 });
      if (r.code !== 0 || !r.stdout.trim()) throw new Error(`DPAPI protect failed: ${r.stderr.trim().split('\n')[0] ?? r.error}`);
      writeFileSync(this.file(name), r.stdout.trim());
    } else if (this.backend === 'secret-tool') {
      const r = await run(['secret-tool', 'store', '--label', `gatehouse ${name}`, 'service', 'gatehouse', 'name', name], { input: value });
      if (r.code !== 0) throw new Error(`secret-tool store failed: ${r.stderr.trim()}`);
      writeFileSync(this.file(name), '');
    } else {
      writeFileSync(this.file(name), value, { mode: 0o600 });
      chmodSync(this.file(name), 0o600);
    }
    this.cache.set(name, value);
  }

  async get(name: string): Promise<string | null> {
    assertName(name);
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    if (!existsSync(this.file(name))) return null;
    let value: string;
    if (this.backend === 'dpapi') {
      const r = await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_UNPROTECT], {
        input: readFileSync(this.file(name), 'utf8'),
        timeoutMs: 30_000,
      });
      if (r.code !== 0) throw new Error(`DPAPI unprotect failed for ${name} (stored by another user or machine?)`);
      value = r.stdout.replace(/\r?\n$/, '');
    } else if (this.backend === 'secret-tool') {
      const r = await run(['secret-tool', 'lookup', 'service', 'gatehouse', 'name', name]);
      if (r.code !== 0) return null;
      value = r.stdout.replace(/\n$/, '');
    } else {
      value = readFileSync(this.file(name), 'utf8');
    }
    this.cache.set(name, value);
    return value;
  }

  async require(name: string): Promise<string> {
    const value = await this.get(name);
    if (value === null) throw new Error(`secret ${name} is not set; run: gatehouse secret set ${name}`);
    return value;
  }

  has(name: string): boolean {
    assertName(name);
    return existsSync(this.file(name));
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.secret'))
      .map((f) => f.slice(0, -'.secret'.length))
      .sort();
  }

  async remove(name: string): Promise<void> {
    assertName(name);
    if (this.backend === 'secret-tool') await run(['secret-tool', 'clear', 'service', 'gatehouse', 'name', name]);
    rmSync(this.file(name), { force: true });
    this.cache.delete(name);
  }

  private file(name: string): string {
    return join(this.dir, `${name}.secret`);
  }
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid secret name: ${name}`);
}

const PS_PROTECT = [
  '$ErrorActionPreference = "Stop"',
  '$v = [Console]::In.ReadToEnd()',
  '$s = ConvertTo-SecureString -String $v -AsPlainText -Force',
  'ConvertFrom-SecureString -SecureString $s',
].join('; ');

const PS_UNPROTECT = [
  '$ErrorActionPreference = "Stop"',
  '$e = [Console]::In.ReadToEnd().Trim()',
  '$s = ConvertTo-SecureString -String $e',
  '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)',
  'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
].join('; ');
