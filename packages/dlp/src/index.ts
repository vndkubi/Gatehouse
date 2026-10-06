import { createHash } from 'node:crypto';

export type DetectorClass = 'account-data' | 'secret';

export interface Hit {
  detector: string;
  cls: DetectorClass;
  start: number;
  end: number;
  /** First 8 hex chars of sha256(value): lets logs correlate hits without ever holding the value. */
  hash8: string;
}

export interface DlpOptions {
  /** Published brand test PANs that may appear in fixtures. */
  testPanAllowlist?: string[];
}

interface Detector {
  name: string;
  cls: DetectorClass;
  re: RegExp;
  /** Index of the capture group holding the sensitive value (0 = whole match). */
  group?: number;
  accept?: (value: string, opts: DlpOptions) => boolean;
}

const DETECTORS: Detector[] = [
  // Account data (PCI): any hit here must never leave the machine.
  { name: 'pan', cls: 'account-data', re: /(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d])/g, accept: isPlausiblePan },
  { name: 'track1', cls: 'account-data', re: /%B\d{13,19}\^[^^\n]{2,26}\^\d{4}/g },
  { name: 'track2', cls: 'account-data', re: /;\d{13,19}=\d{4}\d*\??/g },
  // Credentials.
  { name: 'github-token', cls: 'secret', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { name: 'openai-style-key', cls: 'secret', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws-access-key', cls: 'secret', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'slack-token', cls: 'secret', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'private-key', cls: 'secret', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g },
  {
    name: 'assigned-secret',
    cls: 'secret',
    re: /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?([^\s"',;]{12,})/gi,
    group: 1,
    accept: (v) => entropy(v) >= 3.5 && !/^\$\{|^%\(|^<|^\{\{/.test(v),
  },
];

export function scan(text: string, opts: DlpOptions = {}): Hit[] {
  const hits: Hit[] = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of text.matchAll(d.re)) {
      const value = d.group ? m[d.group] : m[0];
      if (!value) continue;
      if (d.accept && !d.accept(value, opts)) continue;
      const start = m.index + (d.group ? m[0].indexOf(value) : 0);
      hits.push({ detector: d.name, cls: d.cls, start, end: start + value.length, hash8: hash8(value) });
    }
  }
  return dedupe(hits);
}

/** Replaces every hit with a stable placeholder; the same value always maps to the same token. */
export function redact(text: string, opts: DlpOptions = {}): { text: string; hits: Hit[] } {
  const hits = scan(text, opts);
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    out += text.slice(cursor, h.start) + (h.detector === 'pan' ? `[PAN:${h.hash8}]` : `[REDACTED:${h.detector}:${h.hash8}]`);
    cursor = h.end;
  }
  return { text: out + text.slice(cursor), hits };
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function isPlausiblePan(raw: string, opts: DlpOptions): boolean {
  const digits = raw.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // Payment networks issue from 2-6 (Mastercard 2-series, Amex/Diners/JCB 3, Visa 4, MC 5, Discover/UnionPay 6).
  if (!/^[2-6]/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  if (!luhnValid(digits)) return false;
  return !(opts.testPanAllowlist ?? []).includes(digits);
}

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function hash8(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function dedupe(hits: Hit[]): Hit[] {
  const sorted = hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Hit[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) continue; // overlapping: keep the earlier, wider hit
    out.push(h);
  }
  return out;
}
