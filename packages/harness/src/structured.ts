import type { RunTokenSigner } from '@gatehouse/core';
import { extractJson, validate } from './json.ts';

/**
 * How the server is asked to constrain the answer. `json_schema` needs guided decoding on the
 * serving side (OpenAI strict mode, vLLM with xgrammar/outlines); `json_object` only promises
 * syntactically valid JSON (DeepSeek); `none` relies on the prompt. Gatehouse validates the
 * answer against the schema in every case.
 */
export type ResponseFormat = 'json_schema' | 'json_object' | 'none';

export interface StructuredRequest {
  runId: string;
  stepId: string;
  tier: string;
  /** Static instructions; sent first so every call of a step shares the same cached prefix. */
  system: string;
  /**
   * The user message, ordered from the most shared to the least: e.g. requirements and the item
   * catalog (same for the whole run), then a region's context pack (same for its batches). A
   * provider prefix cache can only hit on a byte-identical prefix that starts at token 0.
   */
  prefix: string[];
  /** The part that changes per call (the batch of items); always last. */
  tail: string;
  schema: Record<string, unknown>;
  responseFormat: ResponseFormat;
  /** Corrections after an invalid answer (default 1). */
  maxRepairs?: number;
  timeoutMs: number;
  maxTokens?: number;
}

export interface CallUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
}

export interface StructuredResult {
  ok: boolean;
  output?: unknown;
  errors: string[];
  attempts: number;
  durationMs: number;
  usage: CallUsage;
}

/** One non-agentic model call: no tools, no loop, one schema-checked answer. */
export interface StructuredCaller {
  call(req: StructuredRequest): Promise<StructuredResult>;
}

export interface GatewayCallerOptions {
  gatewayUrl: string;
  signer: RunTokenSigner;
  fetchImpl?: typeof fetch;
  /** Backoff for 429/5xx before giving up (default 3 retries). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export function structuredMessages(req: StructuredRequest): Message[] {
  return [
    { role: 'system', content: `${req.system.trim()}\n\n## Output contract\nReply with exactly one JSON object that validates against this JSON Schema. No prose before or after it.\n\`\`\`json\n${JSON.stringify(req.schema)}\n\`\`\`` },
    { role: 'user', content: [...req.prefix, req.tail].join('\n\n') },
  ];
}

/**
 * Single-pass structured calls through the Gatehouse gateway (run token, tier alias, DLP and
 * budget all apply there). A repair appends the bad answer and the validation errors after the
 * original messages, so the repaired call still shares the original prefix.
 */
export class GatewayStructuredCaller implements StructuredCaller {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GatewayCallerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call(req: StructuredRequest): Promise<StructuredResult> {
    const started = Date.now();
    const usage: CallUsage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
    const errors: string[] = [];
    const messages = structuredMessages(req);
    const maxAttempts = 1 + (req.maxRepairs ?? 1);
    const done = (ok: boolean, attempts: number, output?: unknown): StructuredResult => ({ ok, output, errors, attempts, durationMs: Date.now() - started, usage });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reply = await this.complete(req, messages, usage);
      if ('error' in reply) {
        errors.push(`attempt ${attempt}: ${reply.error}`);
        return done(false, attempt);
      }
      let output: unknown;
      let problems: string[];
      try {
        output = extractJson(reply.content);
        problems = validate(req.schema, output);
      } catch (err) {
        problems = [(err as Error).message];
      }
      if (!problems.length) return done(true, attempt, output);
      errors.push(`attempt ${attempt}: schema: ${problems.slice(0, 5).join('; ')}`);
      messages.push({ role: 'assistant', content: reply.content.slice(0, 20_000) });
      messages.push({ role: 'user', content: `Your reply did not satisfy the output contract:\n${problems.slice(0, 10).map((p) => `- ${p}`).join('\n')}\nReply again with only the corrected JSON object.` });
    }
    return done(false, maxAttempts);
  }

  private async complete(req: StructuredRequest, messages: Message[], usage: CallUsage): Promise<{ content: string } | { error: string }> {
    const body: Record<string, unknown> = { model: req.tier, messages, temperature: 0, stream: false };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.responseFormat === 'json_object') body.response_format = { type: 'json_object' };
    if (req.responseFormat === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: req.schema } };
    const retries = this.options.retries ?? 3;
    for (let i = 0; ; i++) {
      const token = this.options.signer.issue(req.runId, req.stepId, req.timeoutMs + 60_000);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.options.gatewayUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(req.timeoutMs),
        });
      } catch (err) {
        if (i < retries) {
          await this.sleep(1_000 * 2 ** i);
          continue;
        }
        return { error: `request failed: ${(err as Error).message}` };
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        if (i < retries) {
          const after = Number(res.headers.get('retry-after'));
          await this.sleep(Number.isFinite(after) && after > 0 ? after * 1_000 : 1_000 * 2 ** i);
          continue;
        }
      }
      if (!res.ok) return { error: `HTTP ${res.status}${res.status === 402 ? ' (token budget exhausted)' : ''}: ${text.slice(0, 300)}` };
      const json = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };
      };
      usage.promptTokens += json.usage?.prompt_tokens ?? 0;
      usage.completionTokens += json.usage?.completion_tokens ?? 0;
      usage.cachedPromptTokens += json.usage?.prompt_cache_hit_tokens ?? json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const content = json.choices?.[0]?.message?.content;
      return content ? { content } : { error: 'empty completion' };
    }
  }
}
