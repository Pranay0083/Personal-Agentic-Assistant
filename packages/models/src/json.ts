import type { z } from 'zod';

/**
 * Pulls the first JSON object out of a model reply. Tolerates code fences and
 * prose around the object. Returns undefined if nothing parses.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [trimmed, fenced?.[1]?.trim()];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

/**
 * Parses a model reply as data with a zod schema. Model output is untrusted data: it is
 * validated here and never used to choose tools, recipients or URLs.
 */
export function parseModelJson<S extends z.ZodType>(text: string, schema: S): z.infer<S> {
  const raw = extractJson(text);
  if (raw === undefined) throw new ModelOutputError('model reply was not JSON');
  const res = schema.safeParse(raw);
  if (!res.success) {
    throw new ModelOutputError(
      `model reply did not match schema: ${res.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.code}`)
        .join('; ')}`,
    );
  }
  return res.data;
}
