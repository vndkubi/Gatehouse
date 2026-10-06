import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface RepoRecord {
  name: string;
  /** What the user gave us: a URL or a local path. */
  source: string;
  /** Bare mirror owned by Gatehouse; never mounted into an agent workspace. */
  mirror: string;
  defaultBranch: string;
  pciScope: 'cde' | 'connected' | 'out';
  addedAt: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validRepoName(name: string): boolean {
  return NAME.test(name) && !name.endsWith('.git');
}

export class RepoRegistry {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS repos (
        name           TEXT PRIMARY KEY,
        source         TEXT NOT NULL,
        mirror         TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        pci_scope      TEXT NOT NULL,
        added_at       TEXT NOT NULL
      );
    `);
  }

  add(record: RepoRecord): void {
    if (!validRepoName(record.name)) throw new Error(`invalid repo name: ${record.name}`);
    this.db
      .prepare('INSERT INTO repos (name, source, mirror, default_branch, pci_scope, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.name, record.source, record.mirror, record.defaultBranch, record.pciScope, record.addedAt);
  }

  get(name: string): RepoRecord | null {
    const row = this.db.prepare('SELECT * FROM repos WHERE name = ?').get(name) as Record<string, string> | undefined;
    return row ? toRecord(row) : null;
  }

  list(): RepoRecord[] {
    return (this.db.prepare('SELECT * FROM repos ORDER BY name').all() as Array<Record<string, string>>).map(toRecord);
  }

  remove(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM repos WHERE name = ?').run(name).changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Record<string, string>): RepoRecord {
  return {
    name: row.name!,
    source: row.source!,
    mirror: row.mirror!,
    defaultBranch: row.default_branch!,
    pciScope: row.pci_scope as RepoRecord['pciScope'],
    addedAt: row.added_at!,
  };
}
