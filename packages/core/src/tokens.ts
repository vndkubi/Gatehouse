import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RunClaims {
  runId: string;
  stepId: string;
  /** Epoch milliseconds. */
  exp: number;
}

/**
 * Short-lived run tokens handed to executors instead of real credentials. The gateway and
 * MCP proxy accept them; nothing outside this machine does.
 */
export class RunTokenSigner {
  constructor(private readonly key: Buffer) {}

  static fromFile(file: string): RunTokenSigner {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    return new RunTokenSigner(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
  }

  issue(runId: string, stepId: string, ttlMs: number, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ runId, stepId, exp: now + ttlMs } satisfies RunClaims)).toString('base64url');
    return `ghr.${body}.${this.sign(body)}`;
  }

  verify(token: string, now = Date.now()): RunClaims | null {
    const [prefix, body, sig] = token.split('.');
    if (prefix !== 'ghr' || !body || !sig) return null;
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RunClaims;
      return claims.exp > now ? claims : null;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
