/**
 * What may be logged about an error. Never the message or the error object itself:
 * drizzle's DrizzleQueryError message carries the query and its params (ids, emails,
 * token hashes, item text). Only the class name and the driver's error code.
 */
export function errorFields(e: unknown): { errName: string; errCode?: string } {
  const name = e instanceof Error ? e.name : typeof e;
  const cause = e instanceof Error ? (e.cause as { code?: unknown } | undefined) : undefined;
  const code = cause && typeof cause.code === 'string' ? cause.code : undefined;
  return code ? { errName: name, errCode: code } : { errName: name };
}
