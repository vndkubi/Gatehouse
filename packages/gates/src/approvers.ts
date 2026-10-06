import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '@gatehouse/core';

export interface Approver {
  credentialId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  name: string;
  aaguid: string;
  createdAt: string;
}

/**
 * Registered human approvers (WebAuthn credentials) and one-time enrollment codes. Only the
 * public key is stored; the private key stays in the authenticator (Windows Hello / TPM).
 */
export class ApproverStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS approvers (
        credential_id TEXT PRIMARY KEY,
        public_key    TEXT NOT NULL,
        counter       INTEGER NOT NULL,
        name          TEXT NOT NULL,
        aaguid        TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS enroll_codes (
        code_hash   TEXT PRIMARY KEY,
        expires_at  INTEGER NOT NULL,
        authorized  INTEGER NOT NULL DEFAULT 0,
        used        INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  list(): Approver[] {
    return (this.db.prepare('SELECT * FROM approvers ORDER BY created_at').all() as Array<Record<string, string | number>>).map((r) => ({
      credentialId: String(r.credential_id),
      publicKey: String(r.public_key),
      counter: Number(r.counter),
      name: String(r.name),
      aaguid: String(r.aaguid),
      createdAt: String(r.created_at),
    }));
  }

  get(credentialId: string): Approver | null {
    return this.list().find((a) => a.credentialId === credentialId) ?? null;
  }

  add(a: Approver): void {
    this.db
      .prepare('INSERT INTO approvers (credential_id, public_key, counter, name, aaguid, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.credentialId, a.publicKey, a.counter, a.name, a.aaguid, a.createdAt);
  }

  setCounter(credentialId: string, counter: number): void {
    this.db.prepare('UPDATE approvers SET counter = ? WHERE credential_id = ?').run(counter, credentialId);
  }

  /**
   * Issues a one-time code (printed in the terminal by `gatehouse approver enroll`). With no
   * approvers yet the code alone allows the first enrollment; afterwards an existing approver
   * must also authorize it, so a process that can run the CLI cannot add its own key.
   */
  issueCode(ttlMs = 10 * 60_000): string {
    const code = randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
    this.db.prepare('INSERT INTO enroll_codes (code_hash, expires_at, authorized) VALUES (?, ?, ?)').run(sha256Hex(code), Date.now() + ttlMs, this.list().length === 0 ? 1 : 0);
    return code;
  }

  codeState(code: string): 'unknown' | 'expired' | 'used' | 'needs-authorization' | 'ready' {
    const row = this.db.prepare('SELECT * FROM enroll_codes WHERE code_hash = ?').get(sha256Hex(code.trim().toUpperCase())) as Record<string, number> | undefined;
    if (!row) return 'unknown';
    if (row.used) return 'used';
    if (row.expires_at! < Date.now()) return 'expired';
    return row.authorized ? 'ready' : 'needs-authorization';
  }

  authorizeCode(code: string): void {
    this.db.prepare('UPDATE enroll_codes SET authorized = 1 WHERE code_hash = ?').run(sha256Hex(code.trim().toUpperCase()));
  }

  consumeCode(code: string): void {
    this.db.prepare('UPDATE enroll_codes SET used = 1 WHERE code_hash = ?').run(sha256Hex(code.trim().toUpperCase()));
  }

  close(): void {
    this.db.close();
  }
}
