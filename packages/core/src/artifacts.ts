import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex } from './hash.ts';

export type TrustLevel = 'CANDIDATE' | 'VALIDATED' | 'REVIEWED' | 'APPROVED' | 'PUBLISHED';

export interface ArtifactMeta {
  hash: string;
  kind: string;
  mediaType: string;
  trust: TrustLevel;
  createdAt: string;
  /** Where it came from: run, step, input hashes, ... */
  provenance: Record<string, unknown>;
}

/**
 * Content-addressed, immutable blob store. A blob never changes once written; trust is
 * raised by attestations elsewhere, never by rewriting content.
 */
export class ArtifactStore {
  constructor(private readonly root: string) {}

  put(kind: string, content: string | Uint8Array, mediaType: string, provenance: Record<string, unknown> = {}): ArtifactMeta {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = sha256Hex(bytes);
    const blob = this.blobPath(hash);
    if (!existsSync(blob)) atomicWrite(blob, bytes);
    const metaFile = this.metaPath(hash);
    if (existsSync(metaFile)) return this.meta(hash)!;
    const meta: ArtifactMeta = { hash, kind, mediaType, trust: 'CANDIDATE', createdAt: new Date().toISOString(), provenance };
    atomicWrite(metaFile, Buffer.from(JSON.stringify(meta, null, 2)));
    return meta;
  }

  putJson(kind: string, value: unknown, provenance: Record<string, unknown> = {}): ArtifactMeta {
    return this.put(kind, `${JSON.stringify(value, null, 2)}\n`, 'application/json', provenance);
  }

  read(hash: string): Buffer {
    const bytes = readFileSync(this.blobPath(hash));
    if (sha256Hex(bytes) !== hash) throw new Error(`artifact ${hash} is corrupted`);
    return bytes;
  }

  meta(hash: string): ArtifactMeta | null {
    const file = this.metaPath(hash);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ArtifactMeta) : null;
  }

  private blobPath(hash: string): string {
    return join(this.root, 'objects', hash.slice(0, 2), hash);
  }

  private metaPath(hash: string): string {
    return join(this.root, 'meta', hash.slice(0, 2), `${hash}.json`);
  }
}

function atomicWrite(file: string, bytes: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}
