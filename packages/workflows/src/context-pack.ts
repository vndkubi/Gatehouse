import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { git } from '@gatehouse/targets';
import type { Region } from './audit.ts';
import type { BlastRadius } from './blast.ts';
import { numberedHunk, type Hunk } from './diff.ts';
import { untrusted } from './registry.ts';

/**
 * Deterministic context packs (design 09 §2). A pack is what the single-pass auditor sees for a
 * region: the numbered hunks, the callers outside the diff, and the service-boundary signals in
 * the changed code with whatever contract or config the repo itself holds for them. It is built
 * small on purpose; arm C asks for more only when an item says what is missing.
 */

export type BoundaryKind = 'http-client' | 'messaging' | 'transaction' | 'resilience' | 'authorization' | 'idempotency';

export interface BoundarySignal {
  kind: BoundaryKind;
  file: string;
  line: number;
  text: string;
  /** Identifiers worth looking up (client interface, topic, config prefix). */
  lookups: string[];
}

const BOUNDARY: Array<[BoundaryKind, RegExp]> = [
  // Includes injected client types (`PaymentClient payments`): a BFF's downstream calls usually go through one.
  ['http-client', /@FeignClient|RestTemplate|WebClient|RestClient|HttpClient\b|fetch\(|axios\.|@HttpExchange|\b[A-Z]\w*(?:Client|Api)\s+\w+\s*[;=,)]/],
  ['messaging', /KafkaTemplate|@KafkaListener|@RabbitListener|RabbitTemplate|StreamBridge|@StreamListener|@JmsListener|JmsTemplate|@SqsListener|publishEvent\(/],
  ['transaction', /@Transactional|TransactionTemplate|\.commit\(\)|\.rollback\(\)/],
  ['resilience', /@Retryable|@Retry\b|@CircuitBreaker|@Bulkhead|@TimeLimiter|resilience4j|\bretry\b.*\(|timeout/i],
  ['authorization', /@PreAuthorize|@Secured|@RolesAllowed|hasRole|hasAuthority|SecurityContextHolder/],
  ['idempotency', /[Ii]dempoten|Idempotency-Key|requestId|dedup/],
];

const IDENT = /\b([A-Z][A-Za-z0-9]{3,}(?:Client|Service|Api|Gateway|Template|Listener|Publisher|Producer|Consumer))\b/g;
const QUOTED = /["']([a-z0-9][\w.-]{3,})["']/g;

/** Boundary signals on the changed and surrounding lines of the region's hunks. */
export function boundarySignals(hunks: Hunk[]): BoundarySignal[] {
  const out: BoundarySignal[] = [];
  for (const h of hunks) {
    let n = h.newStart;
    for (const raw of h.text.split('\n').slice(1)) {
      if (raw.startsWith('-') || raw.startsWith('\\')) continue;
      const line = raw.slice(1);
      for (const [kind, re] of BOUNDARY) {
        if (!re.test(line)) continue;
        const lookups = [...new Set([...[...line.matchAll(IDENT)].map((m) => m[1]!), ...[...line.matchAll(QUOTED)].map((m) => m[1]!)])].slice(0, 4);
        if (!out.some((s) => s.kind === kind && s.file === h.file && s.line === n)) out.push({ kind, file: h.file, line: n, text: line.trim().slice(0, 200), lookups });
      }
      n++;
    }
  }
  return out;
}

export interface Snippet {
  file: string;
  from: number;
  to: number;
  why: string;
  text: string;
}

function readLines(workspace: string, file: string): string[] | null {
  const abs = resolve(workspace, file);
  if (!abs.startsWith(resolve(workspace) + sep) || !existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size > 2_000_000) return null;
  return readFileSync(abs, 'utf8').split(/\r?\n/);
}

/** Lines [line-before, line+after] of a file, numbered like the hunks. */
export function snippet(workspace: string, file: string, line: number, before: number, after: number, why: string): Snippet | null {
  const lines = readLines(workspace, file);
  if (!lines || line < 1 || line > lines.length) return null;
  const from = Math.max(1, line - before);
  const to = Math.min(lines.length, line + after);
  const text = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
  return { file, from, to, why, text };
}

export function renderSnippets(snippets: Snippet[]): string {
  return snippets.map((s) => `#### ${s.file}:${s.from}-${s.to} (${s.why})\n${untrusted(`code:${s.file}`, s.text)}`).join('\n\n');
}

const CONTRACT_FILES = /(^|\/)(openapi[^/]*\.(ya?ml|json)|swagger[^/]*\.(ya?ml|json)|asyncapi[^/]*\.ya?ml|[^/]+\.proto|[^/]+\.avsc|[^/]+\.graphqls?)$/i;
const CONFIG_FILES = /(^|\/)(application|bootstrap)[^/]*\.(ya?ml|properties)$/i;
const CONFIG_KEYS = /(retry|timeout|resilience4j|circuitbreaker|feign|kafka|rabbit|idempot|max-attempts|backoff|isolation|transaction)/i;

/**
 * Contract and config lines the repo holds for the region's boundary signals: OpenAPI/proto/
 * Avro files that mention a looked-up name, and retry/timeout/messaging keys in Spring config.
 * What is not in the repo (a downstream service's own code) cannot be found here; the auditor
 * must then say so instead of assuming.
 */
export async function contractSnippets(workspace: string, signals: BoundarySignal[], maxSnippets: number): Promise<Snippet[]> {
  if (!signals.length) return [];
  let tracked: string[] = [];
  try {
    tracked = (await git(['-C', workspace, 'ls-files'], { timeoutMs: 30_000 })).split('\n');
  } catch {
    return [];
  }
  const out: Snippet[] = [];
  const names = [...new Set(signals.flatMap((s) => s.lookups))];
  for (const file of tracked.filter((f) => CONTRACT_FILES.test(f))) {
    const lines = readLines(workspace, file);
    if (!lines) continue;
    for (const name of names) {
      const i = lines.findIndex((l) => l.includes(name));
      if (i >= 0) {
        const s = snippet(workspace, file, i + 1, 2, 12, `contract mentioning ${name}`);
        if (s) out.push(s);
      }
      if (out.length >= maxSnippets) return out;
    }
  }
  if (signals.some((s) => s.kind === 'resilience' || s.kind === 'http-client' || s.kind === 'messaging' || s.kind === 'transaction')) {
    for (const file of tracked.filter((f) => CONFIG_FILES.test(f) && !/\/test\//.test(f))) {
      const lines = readLines(workspace, file);
      if (!lines) continue;
      const hits = lines.map((l, i) => (CONFIG_KEYS.test(l) ? i + 1 : 0)).filter(Boolean);
      if (!hits.length) continue;
      const s = snippet(workspace, file, hits[0]!, 1, Math.min(30, hits.at(-1)! - hits[0]! + 1), 'retry / timeout / messaging config');
      if (s) out.push(s);
      if (out.length >= maxSnippets) break;
    }
  }
  return out;
}

export interface ContextPack {
  region: string;
  text: string;
  chars: number;
  hunksInlined: string[];
  hunksNotInlined: string[];
  signals: BoundarySignal[];
}

/**
 * The fixed context for one region, in a stable order so the same region renders to the same
 * bytes in every batch: hunks, callers outside the diff, boundary signals, contract snippets.
 */
export async function buildContextPack(input: {
  workspace: string;
  region: Region;
  hunks: Hunk[];
  blast: BlastRadius;
  maxChars: number;
  maxCallers: number;
  maxContractSnippets: number;
}): Promise<ContextPack> {
  const { region, hunks } = input;
  const parts: string[] = [`## Context pack ${region.id}`, `Files: ${region.files.join(', ')}`];
  const budget = Math.floor(input.maxChars * 0.7);
  let used = 0;
  const inlined: string[] = [];
  for (const h of hunks) {
    const block = `### ${h.id} — ${h.file}\n${untrusted(`diff:${h.id}`, numberedHunk(h))}`;
    if (inlined.length && used + block.length > budget) break;
    parts.push(block);
    used += block.length;
    inlined.push(h.id);
  }
  const notInlined = hunks.map((h) => h.id).filter((id) => !inlined.includes(id));
  if (notInlined.length) parts.push(`(${notInlined.length} hunk(s) not inlined to keep the pack small: ${notInlined.join(', ')}. If an item depends on them, answer cannot_determine and name them in missing_context.)`);

  const callers: Snippet[] = [];
  const usages = region.usages ?? input.blast.symbols.filter((s) => region.files.includes(s.definedIn)).flatMap((s) => s.usages.filter((u) => !u.test));
  for (const u of usages.slice(0, input.maxCallers)) {
    const s = snippet(input.workspace, u.file, u.line, 3, 3, 'caller outside the diff');
    if (s) callers.push(s);
  }
  if (callers.length) parts.push('### Callers outside the diff', renderSnippets(callers));

  const signals = boundarySignals(hunks);
  if (signals.length) {
    parts.push(
      '### Service-boundary signals in the changed code',
      signals.map((s) => `- ${s.kind} at ${s.file}:${s.line}: \`${s.text}\`${s.lookups.length ? ` (names: ${s.lookups.join(', ')})` : ''}`).join('\n'),
    );
    const contracts = await contractSnippets(input.workspace, signals, input.maxContractSnippets);
    parts.push(contracts.length ? renderSnippets(contracts) : '_No contract or config for these boundaries was found in this repository._');
  }
  let text = parts.join('\n\n');
  if (text.length > input.maxChars) text = `${text.slice(0, input.maxChars)}\n(pack truncated at ${input.maxChars} characters)`;
  return { region: region.id, text, chars: text.length, hunksInlined: inlined, hunksNotInlined: notInlined, signals };
}

/**
 * Bounded, deterministic lookup for arm C's context expansion: each lookup is a path, a
 * config key or an identifier. Paths are read directly; identifiers are searched with
 * `git grep`, declarations first. Returns nothing for names the repo does not contain.
 */
export async function resolveLookups(workspace: string, lookups: string[], opts: { maxPerLookup: number; maxSnippets: number; exclude?: Set<string> }): Promise<{ snippets: Snippet[]; notFound: string[] }> {
  const snippets: Snippet[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();
  const push = (s: Snippet | null) => {
    if (!s) return false;
    const k = `${s.file}:${s.from}`;
    if (seen.has(k) || opts.exclude?.has(k)) return false;
    seen.add(k);
    snippets.push(s);
    return true;
  };
  for (const raw of [...new Set(lookups.map((l) => l.trim()).filter((l) => l.length >= 3))].slice(0, 12)) {
    if (snippets.length >= opts.maxSnippets) break;
    const path = /^[\w./-]+\.[A-Za-z0-9]{1,8}(:\d+)?$/.test(raw) && raw.includes('/') ? raw : null;
    if (path) {
      const [file, at] = path.split(':') as [string, string | undefined];
      if (push(snippet(workspace, file, Number(at ?? 1), at ? 10 : 0, at ? 20 : 60, `requested file ${file}`))) continue;
      notFound.push(raw);
      continue;
    }
    const word = raw.replace(/[^\w.-]/g, '');
    if (word.length < 3) continue;
    let out = '';
    try {
      out = await git(['-C', workspace, 'grep', '-n', '-I', '--no-color', '-F', '-e', word, '--', '.'], { timeoutMs: 30_000 });
    } catch {
      out = '';
    }
    const hits = out
      .split('\n')
      .map((l) => /^(.+?):(\d+):(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ file: m[1]!, line: Number(m[2]), text: m[3]! }));
    if (!hits.length) {
      notFound.push(raw);
      continue;
    }
    const isDecl = (t: string) => /\b(class|interface|enum|record|def|function)\b|^\s*[\w.-]+\s*[:=]/.test(t) || new RegExp(`\\s${word.replace(/\./g, '\\.')}\\s*\\(`).test(t);
    const ranked = [...hits.filter((h) => isDecl(h.text)), ...hits.filter((h) => !isDecl(h.text))];
    let added = 0;
    for (const h of ranked) {
      if (added >= opts.maxPerLookup || snippets.length >= opts.maxSnippets) break;
      if (push(snippet(workspace, h.file, h.line, 4, 12, `lookup ${word}`))) added++;
    }
  }
  return { snippets, notFound };
}
