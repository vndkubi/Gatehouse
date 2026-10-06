import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  /** `fully.qualified.Class#method` */
  id: string;
  className: string;
  status: TestStatus;
  /** Failure/error message and the start of its trace, for classifying why a test failed. */
  message?: string;
}

const SKIP = new Set(['.git', 'node_modules', 'src', '.mvn', '.idea']);

/** Collects Surefire/Failsafe XML reports from every module's target directory. */
export function readSurefireReports(root: string): TestResult[] {
  const results = new Map<string, TestResult>();
  for (const dir of findReportDirs(root)) {
    for (const name of readdirSync(dir)) {
      if (!/^TEST-.*\.xml$/.test(name)) continue;
      for (const r of parseSurefireXml(readFileSync(join(dir, name), 'utf8'))) results.set(r.id, r);
    }
  }
  return [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function findReportDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.name === 'target') {
        for (const reports of ['surefire-reports', 'failsafe-reports']) {
          if (existsSync(join(full, reports))) out.push(join(full, reports));
        }
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function parseSurefireXml(xml: string): TestResult[] {
  const out: TestResult[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1]!;
    const body = m[3] ?? '';
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '?';
    const className = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? '?';
    const status: TestStatus = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    const result: TestResult = { id: `${decode(className)}#${decode(name)}`, className: decode(className), status };
    if (status === 'failed') {
      const f = /<(?:failure|error)\b([^>]*)>?([\s\S]{0,600})/.exec(body);
      result.message = decode(`${/\bmessage="([^"]*)"/.exec(f?.[1] ?? '')?.[1] ?? ''} ${f?.[2] ?? ''}`.trim());
    }
    out.push(result);
  }
  return out;
}

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
