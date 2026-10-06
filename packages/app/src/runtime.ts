import { join } from 'node:path';
import {
  ArtifactStore,
  EventStore,
  RepoRegistry,
  RunTokenSigner,
  gatehousePaths,
  loadConfig,
  resolveTier,
  type ExecutorRoute,
  type GatehouseConfig,
  type GatehousePaths,
} from '@gatehouse/core';
import { ApproverStore, consoleWebOrigin, isApproved, type WebAuthnOrigin } from '@gatehouse/gates';
import { LlmGateway } from '@gatehouse/gateway-llm';
import { GitHubClient } from '@gatehouse/github';
import { CodexAdapter, CopilotAdapter } from '@gatehouse/harness';
import { SecretStore } from '@gatehouse/secrets';
import { HostTarget, type ExecutionTarget } from '@gatehouse/targets';
import { CellTarget } from './cell-target.ts';

export interface Runtime {
  config: GatehouseConfig;
  paths: GatehousePaths;
  events: EventStore;
  artifacts: ArtifactStore;
  repos: RepoRegistry;
  approvers: ApproverStore;
  secrets: SecretStore;
  signer: RunTokenSigner;
  host: HostTarget;
  web: WebAuthnOrigin;
  close(): void;
}

export function openRuntime(projectDir = process.cwd()): Runtime {
  const { config } = loadConfig({ projectDir });
  const paths = gatehousePaths(config.paths.home);
  const events = new EventStore(paths.db);
  const repos = new RepoRegistry(paths.db);
  const approvers = new ApproverStore(paths.db);
  return {
    config,
    paths,
    events,
    repos,
    approvers,
    artifacts: new ArtifactStore(paths.artifacts),
    secrets: new SecretStore(paths.secrets),
    signer: RunTokenSigner.fromFile(join(paths.keys, 'run-token.key')),
    host: new HostTarget({ runsDir: paths.runs, mirrorFor: (name) => mirrorOf(repos, name) }),
    web: consoleWebOrigin(config.console.port),
    close: () => {
      events.close();
      repos.close();
      approvers.close();
    },
  };
}

function mirrorOf(repos: RepoRegistry, name: string): string {
  const r = repos.get(name);
  if (!r) throw new Error(`unknown repo ${name}`);
  return r.mirror;
}

/** Where build/test commands run: the developer's host (Version A) or a sandbox cell (Version B). */
export function targetFor(rt: Runtime, kind: 'host' | 'cell' = rt.config.runtime.target): ExecutionTarget {
  if (kind === 'host') return rt.host;
  return new CellTarget({ host: rt.host, config: rt.config, artifacts: rt.artifacts, events: rt.events, repos: rt.repos });
}

/** Starts the per-run LLM gateway; provider keys are read from the SecretStore here, in-process. */
export async function startGateway(rt: Runtime): Promise<{ gateway: LlmGateway; url: string }> {
  const gateway = new LlmGateway({
    config: rt.config,
    signer: rt.signer,
    events: rt.events,
    providerKey: (p) => rt.secrets.require(p.keySecret),
  });
  return { gateway, url: await gateway.start() };
}

export function adapters(rt: Runtime, gatewayUrl: string) {
  return {
    copilot: rt.config.executors.copilot.enabled ? new CopilotAdapter({ gatewayUrl, signer: rt.signer }) : null,
    codex: rt.config.executors.codex.enabled ? new CodexAdapter({ model: rt.config.executors.codex.model }) : null,
  };
}

/** Routes the PCI policy must judge: every provider any tier may hit, plus subscription executors. */
export function routesFor(rt: Runtime, withCritic: boolean): ExecutorRoute[] {
  const routes: ExecutorRoute[] = [];
  const seen = new Set<string>();
  for (const tier of Object.keys(rt.config.llm.tiers)) {
    const { providerName, provider } = resolveTier(rt.config, tier);
    if (seen.has(providerName)) continue;
    seen.add(providerName);
    routes.push({ executor: 'copilot', mode: 'gateway', provider: { name: providerName, config: provider } });
  }
  if (withCritic && rt.config.executors.codex.enabled) routes.push({ executor: 'codex', mode: 'subscription' });
  return routes;
}

export async function githubClient(rt: Runtime, required = false): Promise<GitHubClient | null> {
  const token = await rt.secrets.get(rt.config.github.tokenSecret);
  if (!token && required) throw new Error(`no GitHub token; run: gatehouse secret set ${rt.config.github.tokenSecret}`);
  return new GitHubClient(rt.config.github.apiUrl, token);
}

/** Signature-verified GATE_ENV check, used to decide whether repro/implementation steps may run tests. */
export function envApprovedFor(rt: Runtime) {
  return (onboardRun: string, specHash: string) => isApproved(rt.events, rt.approvers, rt.web, onboardRun, 'GATE_ENV', specHash);
}

export const runIdFor = (prefix: string, ...parts: Array<string | number>) => `${[prefix, ...parts].join('-')}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
