import { git } from '@gatehouse/targets';
import type { FileDiff } from './diff.ts';

export interface Usage {
  file: string;
  line: number;
  text: string;
  test: boolean;
}

export interface BlastRadius {
  /** Changed symbol -> where it is used outside the diff, at head. */
  symbols: Array<{ name: string; definedIn: string; usages: Usage[] }>;
  /** Test files outside the diff that reference changed code: fixtures/tests at risk. */
  testsAtRisk: string[];
  dependentFiles: string[];
}

const STOP = new Set(['get', 'set', 'equals', 'hashCode', 'toString', 'main', 'value', 'values', 'apply', 'build', 'create', 'update', 'delete', 'save', 'find', 'init', 'test', 'run', 'call', 'handle', 'process', 'execute', 'from', 'of', 'map', 'filter', 'list', 'size', 'clear', 'close', 'next', 'then', 'name', 'id', 'type']);

const DECLARATIONS: RegExp[] = [
  /\b(?:class|interface|enum|record)\s+([A-Z]\w{2,})/,
  /\b(?:public|protected|private|static|final|abstract|synchronized|default)\s+[\w<>[\], ?.]+\s+([a-z]\w{3,})\s*\(/,
  /\b(?:function|def)\s+([A-Za-z_]\w{3,})\s*\(/,
  /\bexport\s+(?:const|let|function|class|async function)\s+([A-Za-z_]\w{3,})/,
  /\bconst\s+([A-Z_][A-Z0-9_]{3,})\s*=/,
  /\bstatic\s+final\s+[\w<>]+\s+([A-Z_][A-Z0-9_]{3,})\b/,
];

/** Names declared on changed lines or in hunk headers (git puts the enclosing function there). */
export function changedSymbols(files: FileDiff[], max: number): Array<{ name: string; definedIn: string }> {
  const found = new Map<string, string>();
  for (const f of files) {
    if (f.binary) continue;
    for (const h of f.hunks) {
      const lines = h.text.split('\n');
      const header = /^@@[^@]*@@\s?(.*)$/.exec(lines[0] ?? '')?.[1] ?? '';
      const candidates = [header];
      // A change inside a method body: the enclosing declaration is the nearest one above it,
      // often a context line rather than a changed one.
      let enclosing: string | null = null;
      for (const l of lines.slice(1)) {
        const body = l.slice(1);
        if (l.startsWith('+') || l.startsWith('-')) {
          candidates.push(body);
          if (enclosing) candidates.push(enclosing);
          enclosing = null;
        } else if (DECLARATIONS.some((re) => re.test(body))) {
          enclosing = body;
        }
      }
      for (const line of candidates) {
        for (const re of DECLARATIONS) {
          const name = re.exec(line)?.[1];
          if (name && !STOP.has(name) && !found.has(name)) found.set(name, f.file);
        }
      }
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, max)
    .map(([name, definedIn]) => ({ name, definedIn }));
}

const isTest = (p: string) => /(^|\/)(test|tests|__tests__|spec)\//i.test(p) || /(Test|Tests|IT|Spec)\.\w+$/.test(p) || /\.(test|spec)\.\w+$/.test(p);

/** Deterministic "who else depends on what changed", by word search at head. No LLM. */
export async function blastRadius(workspace: string, files: FileDiff[], maxSymbols: number, maxUsages: number): Promise<BlastRadius> {
  const changed = new Set(files.map((f) => f.file));
  const symbols: BlastRadius['symbols'] = [];
  for (const s of changedSymbols(files, maxSymbols)) {
    let out = '';
    try {
      out = await git(['-C', workspace, 'grep', '-n', '-w', '-I', '--no-color', '-F', '-e', s.name, '--', '.'], { timeoutMs: 60_000 });
    } catch {
      out = ''; // git grep exits 1 when nothing matches
    }
    const usages: Usage[] = [];
    for (const line of out.split('\n')) {
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!m || changed.has(m[1]!)) continue;
      usages.push({ file: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 160), test: isTest(m[1]!) });
      if (usages.length >= maxUsages) break;
    }
    if (usages.length) symbols.push({ ...s, usages });
  }
  const all = symbols.flatMap((s) => s.usages);
  return {
    symbols,
    testsAtRisk: [...new Set(all.filter((u) => u.test).map((u) => u.file))].sort(),
    dependentFiles: [...new Set(all.filter((u) => !u.test).map((u) => u.file))].sort(),
  };
}
