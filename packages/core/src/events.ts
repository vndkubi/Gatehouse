import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Value } from './hash.ts';

export const GENESIS = '0'.repeat(64);

export interface StoredEvent {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: string;
  prevHash: string;
  hash: string;
}

export type ChainCheck = { ok: true; length: number } | { ok: false; brokenAt: number; reason: string };

/**
 * Append-only event log, one hash chain per run. The chain detects edits and deletions;
 * it does not by itself stop a same-user process from rewriting a whole chain — gate
 * approvals carry their own user-presence signatures for that.
 */
export class EventStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS events (
        run_id    TEXT    NOT NULL,
        seq       INTEGER NOT NULL,
        type      TEXT    NOT NULL,
        payload   TEXT    NOT NULL,
        ts        TEXT    NOT NULL,
        prev_hash TEXT    NOT NULL,
        hash      TEXT    NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
  }

  append(runId: string, type: string, rawPayload: unknown, now: Date = new Date()): StoredEvent {
    // Normalize through JSON first so the hashed value is exactly what is stored and read back.
    const payload = JSON.parse(JSON.stringify(rawPayload ?? null)) as unknown;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.db
        .prepare('SELECT seq, hash FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1')
        .get(runId) as { seq: number; hash: string } | undefined;
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? GENESIS;
      const ts = now.toISOString();
      const hash = eventHash({ runId, seq, type, payload, ts, prevHash });
      this.db
        .prepare('INSERT INTO events (run_id, seq, type, payload, ts, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(runId, seq, type, JSON.stringify(payload), ts, prevHash, hash);
      this.db.exec('COMMIT');
      return { runId, seq, type, payload, ts, prevHash, hash };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  list(runId: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT run_id, seq, type, payload, ts, prev_hash, hash FROM events WHERE run_id = ? ORDER BY seq')
      .all(runId) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      runId: String(r.run_id),
      seq: Number(r.seq),
      type: String(r.type),
      payload: JSON.parse(String(r.payload)) as unknown,
      ts: String(r.ts),
      prevHash: String(r.prev_hash),
      hash: String(r.hash),
    }));
  }

  runs(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT run_id FROM events ORDER BY run_id').all() as Array<{ run_id: string }>;
    return rows.map((r) => r.run_id);
  }

  verify(runId: string): ChainCheck {
    const events = this.list(runId);
    let prev = GENESIS;
    for (const [i, e] of events.entries()) {
      if (e.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: `missing event seq ${i + 1}` };
      if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: 'prev_hash does not match previous event' };
      if (eventHash(e) !== e.hash) return { ok: false, brokenAt: e.seq, reason: 'content does not match hash' };
      prev = e.hash;
    }
    return { ok: true, length: events.length };
  }

  close(): void {
    this.db.close();
  }
}

function eventHash(e: Pick<StoredEvent, 'runId' | 'seq' | 'type' | 'payload' | 'ts' | 'prevHash'>): string {
  return sha256Value({ runId: e.runId, seq: e.seq, type: e.type, payload: e.payload ?? null, ts: e.ts, prevHash: e.prevHash });
}
