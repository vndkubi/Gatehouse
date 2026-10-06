import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ClassCoverage {
  /** fully.qualified.ClassName */
  className: string;
  sourceFile: string;
  /** Repo-relative path of the source file when found. */
  path: string | null;
  lineMissed: number;
  lineCovered: number;
  branchMissed: number;
  branchCovered: number;
  methods: number;
}

const SKIP = new Set(['.git', 'node_modules', 'src', '.mvn', '.idea']);

/** Reads every module's target/site/jacoco/jacoco.xml (class-level counters only). */
export function readJacoco(root: string): ClassCoverage[] {
  const out = new Map<string, ClassCoverage>();
  const sources = indexSources(root);
  for (const file of findReports(root)) {
    const xml = readFileSync(file, 'utf8');
    for (const pkg of xml.matchAll(/<package name="([^"]*)">([\s\S]*?)<\/package>/g)) {
      for (const cls of pkg[2]!.matchAll(/<class name="([^"]+)"(?:\s+sourcefilename="([^"]*)")?[^>]*>([\s\S]*?)<\/class>/g)) {
        const name = cls[1]!.replace(/\//g, '.');
        if (name.includes('$')) continue; // inner classes roll up into the outer one
        const body = cls[3]!;
        const methods = (body.match(/<method\b/g) ?? []).length;
        const own = body.replace(/<method\b[\s\S]*?<\/method>/g, '');
        const counter = (type: string) => {
          const m = new RegExp(`<counter type="${type}" missed="(\\d+)" covered="(\\d+)"`).exec(own);
          return m ? [Number(m[1]), Number(m[2])] : [0, 0];
        };
        const [lm, lc] = counter('LINE');
        const [bm, bc] = counter('BRANCH');
        const sourceFile = cls[2] ?? `${name.split('.').pop()}.java`;
        const pkgPath = pkg[1]!;
        out.set(name, {
          className: name,
          sourceFile,
          path: sources.get(`${pkgPath}/${sourceFile}`) ?? null,
          lineMissed: lm!,
          lineCovered: lc!,
          branchMissed: bm!,
          branchCovered: bc!,
          methods,
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.lineMissed - a.lineMissed || a.className.localeCompare(b.className));
}

export const linePct = (c: Pick<ClassCoverage, 'lineMissed' | 'lineCovered'>) => (c.lineMissed + c.lineCovered ? (100 * c.lineCovered) / (c.lineMissed + c.lineCovered) : 100);
export const branchPct = (c: Pick<ClassCoverage, 'branchMissed' | 'branchCovered'>) => (c.branchMissed + c.branchCovered ? (100 * c.branchCovered) / (c.branchMissed + c.branchCovered) : 100);

function findReports(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.name === 'target') {
        const report = join(full, 'site', 'jacoco', 'jacoco.xml');
        if (existsSync(report)) out.push(report);
      } else walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** "com/acme/Pay.java" -> repo-relative path under any module's src/main/java. */
function indexSources(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 14) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!['.git', 'node_modules', 'target', 'build'].includes(e.name)) walk(full, depth + 1);
      } else if (e.name.endsWith('.java') || e.name.endsWith('.kt')) {
        const rel = relative(root, full).split(sep).join('/');
        const m = /src\/main\/(?:java|kotlin)\/(.+)$/.exec(rel);
        if (m) map.set(m[1]!, rel);
      }
    }
  };
  walk(root, 0);
  return map;
}
