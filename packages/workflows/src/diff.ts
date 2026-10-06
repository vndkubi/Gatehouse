export interface Hunk {
  id: string;
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk text including the @@ header. */
  text: string;
  /** New-side line numbers present in the hunk (added + context): valid targets for inline comments. */
  commentable: number[];
  added: number;
}

export interface FileDiff {
  file: string;
  oldFile: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  hunks: Hunk[];
}

/** Parses `git diff` unified output (no color, default prefixes). Deterministic hunk ids H1..Hn. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let newLine = 0;
  let counter = 0;
  const unquote = (p: string) => p.replace(/^"|"$/g, '').replace(/^[ab]\//, '');

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      current = { file: m?.[2] ?? '', oldFile: m?.[1] ?? null, status: 'modified', binary: false, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) current.status = 'renamed';
    else if (line.startsWith('Binary files ')) current.binary = true;
    else if (line.startsWith('--- ')) current.oldFile = line.slice(4) === '/dev/null' ? null : unquote(line.slice(4));
    else if (line.startsWith('+++ ')) {
      if (line.slice(4) !== '/dev/null') current.file = unquote(line.slice(4));
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      hunk = {
        id: `H${++counter}`,
        file: current.file,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        text: line,
        commentable: [],
        added: 0,
      };
      newLine = hunk.newStart;
      current.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith('\\')) {
        hunk.text += `\n${line}`;
        continue;
      }
      const tag = line[0];
      if (tag !== '+' && tag !== '-' && tag !== ' ' && line !== '') continue;
      hunk.text += `\n${line}`;
      if (tag === '+') {
        hunk.commentable.push(newLine++);
        hunk.added++;
      } else if (tag === ' ' || line === '') {
        hunk.commentable.push(newLine++);
      }
    }
  }
  return files;
}

/** Hunk text annotated with new-side line numbers, which is what reviewers must cite. */
export function numberedHunk(h: Hunk): string {
  const out: string[] = [];
  let n = h.newStart;
  for (const line of h.text.split('\n')) {
    if (line.startsWith('@@')) out.push(line);
    else if (line.startsWith('-')) out.push(`      ${line}`);
    else if (line.startsWith('\\')) out.push(`      ${line}`);
    else out.push(`${String(n++).padStart(5)} ${line}`);
  }
  return out.join('\n');
}
