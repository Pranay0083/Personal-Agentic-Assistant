import type { FastifyError, FastifyInstance } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';

/** Error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string) => new HttpError(400, 'invalid_request', message);
export const conflict = (code: string, message?: string) => new HttpError(409, code, message);

/** Parses with zod; ZodError is turned into a 400 by the error handler. */
export function parse<S extends ZodType>(schema: S, input: unknown): z.output<S> {
  return schema.parse(input ?? {}) as z.output<S>;
}

const IdParam = z.object({ id: z.uuid() });

/** `:id` route params must be UUIDs; anything else can't exist, so it's a 404. */
export function idParam(params: unknown): string {
  const r = IdParam.safeParse(params);
  if (!r.success) throw notFound();
  return r.data.id;
}

function zodMessage(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'not_found', message: 'route not found' });
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request', message: zodMessage(err) });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'invalid_request', message: err.message });
    }
    // Only the error itself: never the request body, which can hold message text or secrets.
    req.log.error({ err: { name: err.name, message: err.message, stack: err.stack } }, 'error');
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local calendar date (YYYY-MM-DD) in a timezone. */
export function localDate(now: Date, timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Parses an ISO timestamp from a request, or throws 400. */
export function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field}: invalid date`);
  return d;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
