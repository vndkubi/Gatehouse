import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Hunk } from './diff.ts';
import { REGISTRY } from './registry.ts';

export interface Viewpoint {
  id: string;
  title: string;
  mandatory: boolean;
  paths: string[];
  content: string[];
  checklist: string[];
}

export function loadRiskRouting(name = 'risk-routing'): Viewpoint[] {
  const doc = parseYaml(readFileSync(join(REGISTRY, 'policies', `${name}.yml`), 'utf8')) as { viewpoints: Viewpoint[] };
  for (const v of doc.viewpoints) {
    if (!/^[a-z0-9-]+$/.test(v.id)) throw new Error(`risk-routing: invalid viewpoint id ${v.id}`);
    for (const re of v.content ?? []) new RegExp(re, 'i'); // fail fast on bad patterns
  }
  return doc.viewpoints.map((v) => ({ ...v, paths: v.paths ?? [], content: v.content ?? [], checklist: v.checklist ?? [], mandatory: !!v.mandatory }));
}

/** Glob with `**` (any depth), `*` (within a segment) and `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Hunks that trigger a viewpoint: by file path or by changed (+/-) line content. */
export function matchViewpoint(v: Viewpoint, hunks: Hunk[]): Hunk[] {
  const paths = v.paths.map(globToRegExp);
  const content = v.content.map((c) => new RegExp(c, 'i'));
  return hunks.filter((h) => {
    if (paths.some((p) => p.test(h.file))) return true;
    const changed = h.text.split('\n').filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
    return changed.some((l) => content.some((re) => re.test(l)));
  });
}
