import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Files any agent CLI auto-loads as instructions or tool config, at any depth. */
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'GEMINI.md', '.mcp.json']);
/** Repo-relative paths (files or directories) that configure agents, hooks or MCP servers. */
const INSTRUCTION_PATHS = [
  '.github/copilot-instructions.md',
  '.github/agents',
  '.github/instructions',
  '.github/prompts',
  '.github/hooks',
  '.github/skills',
  '.codex',
  '.copilot',
  '.claude',
  '.vscode/mcp.json',
];
const SKIP = new Set(['.git', 'node_modules', 'target', 'build', 'dist']);

/**
 * Removes repo-provided agent instructions and MCP/hook config from a workspace before any
 * agent runs in it (design 05 §1.5). In a PR review the PR author controls these files, so
 * they are a direct injection channel. Originals are kept under `keepDir` so they can still
 * be reviewed as ordinary (tainted) changes.
 */
export function maskAgentInstructions(workspace: string, keepDir: string): string[] {
  const masked: string[] = [];
  const take = (abs: string) => {
    const rel = relative(workspace, abs).split(sep).join('/');
    const dest = join(keepDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(abs, dest, { recursive: true });
    rmSync(abs, { recursive: true, force: true });
    masked.push(rel);
  };
  for (const p of INSTRUCTION_PATHS) {
    const abs = join(workspace, ...p.split('/'));
    if (existsSync(abs)) take(abs);
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(abs, depth + 1);
      } else if (INSTRUCTION_FILES.has(entry.name) && statSync(abs).isFile()) {
        take(abs);
      }
    }
  };
  walk(workspace, 0);
  return masked.sort();
}
