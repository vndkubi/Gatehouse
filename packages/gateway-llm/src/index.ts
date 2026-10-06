import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveTier, type EventStore, type GatehouseConfig, type LlmProvider, type RunClaims, type RunTokenSigner } from '@gatehouse/core';
import { redact, scan, type DlpOptions } from '@gatehouse/dlp';

export interface GatewayOptions {
  config: GatehouseConfig;
  signer: RunTokenSigner;
  events: EventStore;
  /** Resolves a provider's API key (from the SecretStore). Called lazily, cached by the store. */
  providerKey: (provider: LlmProvider) => Promise<string>;
  dlp?: DlpOptions;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
}

export interface RunUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** null when any provider used lacks pricing. */
  costUsd: number | null;
}

const MAX_BODY = 32 * 1024 * 1024;

/**
 * OpenAI-compatible egress point for every gateway-routed model call. Executors hold only a
 * run token; this process holds the provider keys, maps tier aliases to models, blocks
 * account data (PCI) before it leaves the machine, redacts credentials, enforces the run
 * budget and records each call as an event.
 */
export class LlmGateway {
  private server: Server | null = null;
  private readonly usage = new Map<string, RunUsage>();
  private readonly budgets = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GatewayOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(port = this.options.config.llm.gatewayPort): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: Error) => sendJson(res, 502, { error: { message: `gateway error: ${err.message}` } }));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    const { port: actual } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${actual}/v1`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Per-run token budget (overrides llm.budgetTokensPerRun for that run). */
  setBudget(runId: string, tokens: number): void {
    this.budgets.set(runId, tokens);
  }

  budgetFor(runId: string): number {
    return this.budgets.get(runId) ?? this.options.config.llm.budgetTokensPerRun;
  }

  usageFor(runId: string): RunUsage {
    return this.usage.get(runId) ?? { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const claims = this.authenticate(req);
    if (!claims) return sendJson(res, 401, { error: { message: 'invalid or expired run token' } });

    if (req.method === 'GET' && /^\/(v1\/)?models$/.test(url.pathname)) {
      return sendJson(res, 200, { object: 'list', data: Object.keys(this.options.config.llm.tiers).map((id) => ({ id, object: 'model', owned_by: 'gatehouse' })) });
    }
    if (req.method !== 'POST' || !/^\/(v1\/)?chat\/completions$/.test(url.pathname)) {
      return sendJson(res, 404, { error: { message: `unsupported endpoint ${req.method} ${url.pathname}` } });
    }

    const body = JSON.parse(await readBody(req)) as ChatRequest;
    const tier = String(body.model ?? '');
    let route: ReturnType<typeof resolveTier>;
    try {
      route = resolveTier(this.options.config, tier);
    } catch (err) {
      return sendJson(res, 400, { error: { message: `${(err as Error).message}; request a tier alias such as tier-workhorse` } });
    }
    if (route.provider.type !== 'openai') {
      return sendJson(res, 501, { error: { message: `provider type ${route.provider.type} is not supported by the gateway yet` } });
    }

    // Egress DLP. Account data blocks the request outright; credentials are redacted in place.
    const dlp = { testPanAllowlist: this.options.dlp?.testPanAllowlist ?? this.options.config.pci.testPanAllowlist };
    const accountHits = collectText(body.messages).flatMap((t) => scan(t, dlp)).filter((h) => h.cls === 'account-data');
    if (accountHits.length) {
      this.options.events.append(claims.runId, 'DLP_EGRESS_BLOCK', {
        stepId: claims.stepId,
        detectors: [...new Set(accountHits.map((h) => h.detector))],
        hashes: accountHits.map((h) => h.hash8),
      });
      return sendJson(res, 403, { error: { message: 'blocked by Gatehouse DLP: account data detected in prompt', type: 'dlp_blocked' } });
    }
    const redactions = redactMessages(body.messages, dlp);
    if (redactions.length) {
      this.options.events.append(claims.runId, 'DLP_REDACTED', { stepId: claims.stepId, detectors: [...new Set(redactions.map((h) => h.detector))], count: redactions.length });
    }

    const used = this.usageFor(claims.runId);
    if (used.promptTokens + used.completionTokens >= this.budgetFor(claims.runId)) {
      this.options.events.append(claims.runId, 'BUDGET_EXCEEDED', { stepId: claims.stepId, tokens: used.promptTokens + used.completionTokens });
      // 402, not 429: clients retry 429 with backoff, but an exhausted budget does not come back.
      return sendJson(res, 402, { error: { message: 'Gatehouse run token budget exhausted', type: 'budget_exceeded', code: 'insufficient_quota' } });
    }

    const stream = body.stream === true;
    const upstreamBody: ChatRequest = { ...body, model: route.model };
    if (stream) upstreamBody.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    const started = Date.now();
    const upstream = await this.fetchImpl(`${route.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.options.providerKey(route.provider)}` },
      body: JSON.stringify(upstreamBody),
    });

    const record = (u: Usage | undefined, status: number) => {
      const promptTokens = u?.prompt_tokens ?? 0;
      const completionTokens = u?.completion_tokens ?? 0;
      const cost = price(route.provider, promptTokens, completionTokens);
      const total = this.usageFor(claims.runId);
      this.usage.set(claims.runId, {
        calls: total.calls + 1,
        promptTokens: total.promptTokens + promptTokens,
        completionTokens: total.completionTokens + completionTokens,
        costUsd: total.costUsd === null || cost === null ? null : total.costUsd + cost,
      });
      this.options.events.append(claims.runId, 'MODEL_CALL', {
        stepId: claims.stepId,
        tier,
        provider: route.providerName,
        model: route.model,
        status,
        stream,
        promptTokens,
        completionTokens,
        costUsd: cost,
        durationMs: Date.now() - started,
      });
    };

    if (!stream || !upstream.ok || !upstream.body) {
      const text = await upstream.text();
      let usage: Usage | undefined;
      try {
        usage = (JSON.parse(text) as { usage?: Usage }).usage;
      } catch {
        // non-JSON error body; passed through as-is
      }
      record(usage, upstream.status);
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(text);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let usage: Usage | undefined;
    let buffered = '';
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(chunk);
      buffered += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        try {
          const event = JSON.parse(line.slice(5)) as { usage?: Usage | null };
          if (event.usage) usage = event.usage;
        } catch {
          // partial or non-JSON line
        }
      }
    }
    res.end();
    record(usage, 200);
  }

  private authenticate(req: IncomingMessage): RunClaims | null {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.headers['api-key'] ?? '');
    return token ? this.options.signer.verify(token) : null;
  }
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatRequest {
  model?: string;
  stream?: boolean;
  stream_options?: Record<string, unknown>;
  messages?: unknown[];
  [k: string]: unknown;
}

function price(p: LlmProvider, inTok: number, outTok: number): number | null {
  if (p.pricePerMTokIn === undefined || p.pricePerMTokOut === undefined) return null;
  return (inTok * p.pricePerMTokIn + outTok * p.pricePerMTokOut) / 1_000_000;
}

/** Every string the model will read: message contents, content parts, tool-call arguments. */
function collectText(messages: unknown[] | undefined): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(messages ?? []);
  return out;
}

function redactMessages(messages: unknown[] | undefined, opts: DlpOptions) {
  const hits: ReturnType<typeof scan> = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v, opts);
      hits.push(...r.hits);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = walk(o[k]);
      return o;
    }
    return v;
  };
  if (messages) for (let i = 0; i < messages.length; i++) messages[i] = walk(messages[i]);
  return hits;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
