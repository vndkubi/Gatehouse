import { Ajv, type ErrorObject } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Pulls the answer out of an agent's final message: the last ```json fence if present,
 * otherwise the outermost {...}. The text is only a candidate until it validates.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const fenced = fences.at(-1)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found in agent output');
  return JSON.parse(text.slice(start, end + 1));
}

export function validate(schema: Record<string, unknown>, value: unknown): string[] {
  const check = ajv.compile(schema);
  if (check(value)) return [];
  return (check.errors ?? []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

export function tail(text: string, lines = 30): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}
