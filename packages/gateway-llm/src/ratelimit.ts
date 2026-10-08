import type { LlmRateLimit } from '@gatehouse/core';

const WINDOW_MS = 60_000;

export interface RateTicket {
  at: number;
  tokens: number;
}

/**
 * Sliding one-minute window over requests and tokens for one provider quota (e.g. 60 RPM and
 * 1M TPM shared by every run on this machine). A call waits until both fit. Token counts are
 * estimated before the call and replaced by the provider's reported usage afterwards, so the
 * window converges on what the provider actually counted.
 */
export class RateLimiter {
  private readonly log: RateTicket[] = [];

  constructor(
    readonly limit: LlmRateLimit,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Waits for room and reserves it. Returns the reservation and how long it waited. */
  async acquire(estimatedTokens: number): Promise<{ ticket: RateTicket; waitedMs: number }> {
    const started = this.now();
    for (;;) {
      const t = this.now();
      this.prune(t);
      const wait = this.waitFor(t, estimatedTokens);
      if (wait <= 0) {
        const ticket = { at: t, tokens: estimatedTokens };
        this.log.push(ticket);
        return { ticket, waitedMs: t - started };
      }
      await this.sleep(wait);
    }
  }

  /** Replaces the estimate with what the provider reported for the call. */
  settle(ticket: RateTicket, usage: { promptTokens: number; completionTokens: number; cachedPromptTokens: number }): void {
    const prompt = this.limit.countCachedTokens === false ? usage.promptTokens - usage.cachedPromptTokens : usage.promptTokens;
    ticket.tokens = Math.max(0, prompt) + usage.completionTokens;
  }

  /** Requests and tokens currently counted in the window (for tests and diagnostics). */
  window(): { requests: number; tokens: number } {
    this.prune(this.now());
    return { requests: this.log.length, tokens: this.log.reduce((n, t) => n + t.tokens, 0) };
  }

  private prune(t: number): void {
    while (this.log.length && this.log[0]!.at <= t - WINDOW_MS) this.log.shift();
  }

  /** Milliseconds until a call of this size fits; 0 when it fits now. */
  private waitFor(t: number, tokens: number): number {
    let wait = 0;
    const { rpm, tpm } = this.limit;
    if (rpm && this.log.length >= rpm) wait = Math.max(wait, this.log[this.log.length - rpm]!.at + WINDOW_MS - t);
    if (tpm) {
      // A single call larger than the whole quota still runs, alone in the window.
      const need = Math.min(tokens, tpm);
      let used = this.log.reduce((n, x) => n + x.tokens, 0);
      for (const x of this.log) {
        if (used + need <= tpm) break;
        used -= x.tokens;
        wait = Math.max(wait, x.at + WINDOW_MS - t);
      }
    }
    return wait > 0 ? wait + 5 : 0;
  }
}

/** One limiter per provider per process: concurrent runs share the provider's quota. */
const shared = new Map<string, RateLimiter>();

export function limiterFor(provider: string, limit: LlmRateLimit | undefined): RateLimiter | null {
  if (!limit || (!limit.rpm && !limit.tpm)) return null;
  const key = `${provider}:${limit.rpm ?? 0}:${limit.tpm ?? 0}:${limit.countCachedTokens !== false}`;
  let l = shared.get(key);
  if (!l) shared.set(key, (l = new RateLimiter(limit)));
  return l;
}

/** Conservative pre-call estimate: ~3 characters per token over everything the model reads. */
export function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 3);
}
