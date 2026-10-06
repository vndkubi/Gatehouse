import type { GatehouseConfig, LlmProvider } from './config.ts';

export type PciScope = 'cde' | 'connected' | 'out';

export interface PolicyDecision {
  allow: boolean;
  reasons: string[];
}

/** How an executor reaches its model: through the Gatehouse gateway, or on its own subscription. */
export interface ExecutorRoute {
  executor: 'copilot' | 'codex';
  mode: 'gateway' | 'subscription';
  /** Set for gateway routes. */
  provider?: { name: string; config: LlmProvider };
}

/**
 * Deterministic policy, evaluated by trusted code before any agent step (OPA/Rego later).
 * PCI (06-pci-dss.md §4): in-scope repos may only reach approved providers through the
 * gateway, where DLP can inspect every prompt; subscription routes are out-of-scope only.
 */
export function canRunWorkflow(input: { workflow: string; repo: string; pciScope: PciScope; routes: ExecutorRoute[] }): PolicyDecision {
  const reasons: string[] = [];
  if (input.pciScope !== 'out') {
    for (const r of input.routes) {
      if (r.mode === 'subscription') {
        reasons.push(`${r.executor} runs on its own subscription, which Gatehouse cannot inspect; not allowed for pci.scope=${input.pciScope} repo ${input.repo}`);
      } else if (r.provider && !r.provider.config.tpspApproved) {
        reasons.push(`provider ${r.provider.name} is not an approved TPSP (tpspApproved: false); not allowed for pci.scope=${input.pciScope} repo ${input.repo}`);
      }
    }
  }
  return { allow: reasons.length === 0, reasons };
}

/** Resolves a tier alias to its provider and wire model, or explains why it cannot. */
export function resolveTier(config: GatehouseConfig, tier: string): { providerName: string; provider: LlmProvider; model: string } {
  const target = config.llm.tiers[tier];
  if (!target) throw new Error(`unknown model tier ${tier}`);
  const sep = target.indexOf(':');
  const providerName = target.slice(0, sep);
  const provider = config.llm.providers[providerName];
  if (!provider) throw new Error(`tier ${tier} points at unknown provider ${providerName}`);
  return { providerName, provider, model: target.slice(sep + 1) };
}
