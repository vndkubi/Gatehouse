import { ConfigError, loadConfig } from '@gatehouse/core';
import { scrubEnv, takeFingerprint, type HostFingerprint } from '@gatehouse/targets';
import { envDetect, envVerify, repoAdd, repoFetch, repoList, repoRemove } from './onboard.ts';
import { secretImportEnv, secretList, secretSet } from './secrets-cmd.ts';
import { agentProbeCmd, runBranchReviewCmd, runListCmd, runPrReviewCmd, runResumeCmd, runShowCmd } from './run-cmd.ts';
import { approverEnrollCmd, publishCmd, serveCmd } from './console-cmd.ts';
import { mcpInspectCmd } from './mcp-cmd.ts';
import { evalStatsCmd, retroCmd, runAnswerCmd, runLegacyCmd, runRetryCmd, runTicketCmd } from './pipeline-cmd.ts';
import { bootstrapCheckCmd, envParityCmd } from './sandbox-cmd.ts';
import { agentsCompileCmd, agentsListCmd, ideInstallCmd } from './ide-cmd.ts';
import { mcpServeCmd } from './mcp-serve.ts';

const USAGE = `gatehouse <command> [options]

Commands:
  doctor [--json]    Measure the host toolchain exactly as build/test steps will see it
  config [--json]    Print the resolved config and which layer supplied each value

  repo add <path|url> [--name n] [--branch b] [--pci cde|connected|out]
                     Mirror a repo into Gatehouse (your checkout is never touched)
  repo list [--json] List registered repos
  repo fetch <name>  Update the mirror
  repo remove <name> Unregister and delete the mirror (your checkout is untouched)

  env detect <repo> [--ref r] [--json]
                     Read CI, build files and pins; print the env spec (runs nothing)
  env verify <repo> [--ref r] [--level L1|L2] [--target host|cell] [--keep] [--no-fetch]
                     Detect, then prove the spec on this host: build (L1), test baseline (L2)
  env parity <repo> [--json]
                     Compare the host and cell test baselines (is the sandbox faithful?)
  bootstrap --check [--json]
                     What this machine still needs for sandbox cells (Docker, runtime, WSL, capacity)
  secret set <name>  Store a secret (prompted without echo, or piped on stdin)
  secret import-env <VAR> --as <name>
                     Move a value from an environment variable into the store
  secret list        Names of stored secrets (values are never shown)

  agent probe        One tiny task per executor (Copilot via the gateway, Codex) to prove the wiring

  run pr-review <repo> --pr N [--github owner/name] [--budget-tokens N] [--keep] [--no-critic]
                     Review a pull request; stops at GATE_5 for your approval
  run branch-review <repo> --head <ref> [--base <ref>] [--title t]
                     Review any two refs locally (self-review before opening a PR); nothing is posted
  run ticket <repo> --ticket KEY [--ticket-file path]
                     Ticket → PBI → spec → plan → tasks → test-first implementation → draft PR
  run legacy-tests <repo> [--package com.acme.x] [--top N]
                     Characterization tests for the least-covered classes, with measured coverage
  run answer <runId> --q Q1 --answer "..."
                     Answer a blocking question and continue the run
  run retry <runId> --from <stage> [--note "feedback"] [--budget-tokens N]
                     Re-run a stage (and everything after it), optionally with feedback
  run list           Recent runs
  run resume <runId> [--budget-tokens N]
                     Continue an interrupted run (finished steps are skipped)
  run show <runId>   Event timeline of a run, with hash-chain check

  serve              Start the console (runs, traces, approvals) on http://localhost:8787
  approver enroll    Print a one-time code to register your passkey in the console
  publish <runId>    Retry publishing an approved run: review, or branch + draft PR (re-verifies the signature)
  retro <runId>      Record a decided run as a labelled eval case
  eval stats [--workflow w] [--json]
                     Aggregate eval cases: decisions, verdicts, evidence, tokens

  mcp inspect <server>
                     List an MCP server's tools and how the manifest classifies them
  mcp serve          MCP server (stdio) for IDE agents: start runs and read status via the console

  agents list [--json]
                     Agent Specs in the registry (role, executor, tier, tool scope, version)
  agents compile [--for copilot,codex,claude|all] [--out dir] [--force]
                     Compile the neutral Agent Specs into each executor's native format
  ide install [--target <repo dir>] [--for copilot,codex,claude|all] [--force]
                     Slash commands (/gatehouse-review, -ticket, ...), a Gatehouse agent and the MCP server entry

  help               Show this message
`;

export async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  const json = rest.includes('--json');
  const { positional, flags } = parseArgs(rest);
  try {
    switch (command) {
      case 'repo':
        if (positional[0] === 'add' && positional[1]) return await repoAdd(positional[1], flags);
        if (positional[0] === 'list') return repoList(json);
        if (positional[0] === 'fetch' && positional[1]) return await repoFetch(positional[1]);
        if (positional[0] === 'remove' && positional[1]) return repoRemove(positional[1]);
        return usageError();
      case 'env':
        if (positional[0] === 'detect' && positional[1]) return await envDetect(positional[1], flags);
        if (positional[0] === 'verify' && positional[1]) return await envVerify(positional[1], flags);
        if (positional[0] === 'parity' && positional[1]) return await envParityCmd(positional[1], json);
        return usageError();
      case 'secret':
        if (positional[0] === 'set' && positional[1]) return await secretSet(positional[1]);
        if (positional[0] === 'import-env' && positional[1] && typeof flags.as === 'string') return await secretImportEnv(positional[1], flags.as);
        if (positional[0] === 'list') return secretList();
        return usageError();
      case 'agent':
        if (positional[0] === 'probe') return await agentProbeCmd();
        return usageError();
      case 'run':
        if (positional[0] === 'pr-review' && positional[1]) return await runPrReviewCmd(positional[1], flags);
        if (positional[0] === 'branch-review' && positional[1]) return await runBranchReviewCmd(positional[1], flags);
        if (positional[0] === 'ticket' && positional[1]) return await runTicketCmd(positional[1], flags);
        if (positional[0] === 'legacy-tests' && positional[1]) return await runLegacyCmd(positional[1], flags);
        if (positional[0] === 'answer' && positional[1]) return await runAnswerCmd(positional[1], flags);
        if (positional[0] === 'retry' && positional[1]) return await runRetryCmd(positional[1], flags);
        if (positional[0] === 'list') return runListCmd();
        if (positional[0] === 'resume' && positional[1]) return await runResumeCmd(positional[1], flags);
        if (positional[0] === 'show' && positional[1]) return runShowCmd(positional[1]);
        return usageError();
      case 'serve':
        return await serveCmd();
      case 'approver':
        if (positional[0] === 'enroll') return approverEnrollCmd();
        return usageError();
      case 'publish':
        if (positional[0]) return await publishCmd(positional[0]);
        return usageError();
      case 'retro':
        if (positional[0]) return retroCmd(positional[0]);
        return usageError();
      case 'eval':
        if (positional[0] === 'stats') return evalStatsCmd(flags, json);
        return usageError();
      case 'bootstrap':
        if (flags.check) return await bootstrapCheckCmd(json);
        process.stderr.write('Only `gatehouse bootstrap --check` exists: Gatehouse never installs system software for you.\n');
        return 2;
      case 'agents':
        if (positional[0] === 'list') return agentsListCmd(json);
        if (positional[0] === 'compile') return agentsCompileCmd(flags);
        return usageError();
      case 'ide':
        if (positional[0] === 'install') return ideInstallCmd(flags);
        return usageError();
      case 'mcp':
        if (positional[0] === 'inspect' && positional[1]) return await mcpInspectCmd(positional[1]);
        if (positional[0] === 'serve') return await mcpServeCmd();
        return usageError();
      case 'doctor':
        return await doctor(json);
      case 'config':
        return printConfig(json);
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        return 0;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof Error && !process.env.GATEHOUSE_DEBUG) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function usageError(): number {
  process.stderr.write(USAGE);
  return 2;
}

const VALUE_FLAGS = new Set(['name', 'branch', 'pci', 'ref', 'level', 'as', 'pr', 'github', 'target', 'head', 'base', 'title', 'ticket', 'ticket-file', 'class', 'top', 'out', 'q', 'answer', 'from', 'note', 'package', 'workflow', 'for', 'budget-tokens']);

/** `--flag value`, `--flag=value`, boolean `--flag`, and positionals. */
export function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const next = args[i + 1];
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { positional, flags };
}

async function doctor(json: boolean): Promise<number> {
  loadConfig({ projectDir: process.cwd() });
  const { env, dropped } = scrubEnv(process.env);
  const fp = await takeFingerprint(env);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...fp, scrubbedEnvVars: dropped.length }, null, 2)}\n`);
  } else {
    process.stdout.write(renderFingerprint(fp, dropped.length));
  }
  const usable = fp.tools.git?.found && (fp.tools.copilot?.found || fp.tools.codex?.found);
  return usable ? 0 : 1;
}

export function renderFingerprint(fp: HostFingerprint, droppedVars: number): string {
  const { os } = fp;
  const lines = [
    `Host: ${os.platform} ${os.release} (${os.arch})${os.wsl ? ' [WSL]' : ''} · ${os.cpus} CPU threads · ${os.memoryGb} GB RAM`,
    `Env: ${droppedVars} variables withheld from steps (secrets and anything not allowlisted)`,
    '',
  ];
  const rows = Object.values(fp.tools).map((t) => {
    const status = !t.found ? 'missing' : t.version ? t.version : `error: ${t.error ?? 'unknown'}`;
    const extra = t.detail?.javaVersion ? ` (JDK ${t.detail.javaVersion})` : '';
    return [t.name, status + extra, t.path ?? ''];
  });
  const width = [0, 1].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) lines.push(`  ${r[0]!.padEnd(width[0]!)}  ${r[1]!.padEnd(width[1]!)}  ${r[2]}`);
  if (fp.notes.length) {
    lines.push('', 'Notes:');
    for (const n of fp.notes) lines.push(`  - ${n}`);
  }
  return `${lines.join('\n')}\n`;
}

function printConfig(json: boolean): number {
  const { config, sources } = loadConfig({ projectDir: process.cwd() });
  if (json) {
    process.stdout.write(`${JSON.stringify({ config, sources }, null, 2)}\n`);
    return 0;
  }
  for (const [path, layer] of Object.entries(sources)) {
    const value = path.split('.').reduce<unknown>((cur, k) => (cur as Record<string, unknown>)[k], config);
    process.stdout.write(`${path} = ${JSON.stringify(value)}  [${layer}]\n`);
  }
  return 0;
}
