import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { sessions, users, type Db } from '@hub/db';
import { hashToken, randomToken } from '@hub/server';
import type { GoogleIdentity } from './deps';
import { HttpError, isValidTimezone } from './http';

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

export type AuthContext = { userId: string; sessionId: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

/** Creates a session and returns the raw bearer token. Only its hash is stored. */
export async function createSession(db: Db, userId: string, now: Date): Promise<string> {
  const token = randomToken(32);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return token;
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Timezone hint from the app (`X-Timezone: Europe/Berlin`), if valid. */
export function requestTimezone(req: FastifyRequest): string | null {
  const tz = req.headers['x-timezone'];
  return typeof tz === 'string' && isValidTimezone(tz) ? tz : null;
}

/** Creates the user on first sign-in; fills a missing name. Email is the identity. */
export async function upsertUser(
  db: Db,
  input: { email: string; name?: string | null; timezone?: string | null },
) {
  const email = input.email.trim().toLowerCase();
  const [created] = await db
    .insert(users)
    .values({
      email,
      name: input.name ?? null,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (created) return created;
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (!existing) throw new Error('user upsert failed');
  if (!existing.name && input.name) {
    const [updated] = await db
      .update(users)
      .set({ name: input.name })
      .where(eq(users.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  return existing;
}

const PUBLIC_PREFIXES = ['/auth/', '/oauth/'];

function isPublic(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/healthz' || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Bearer-session auth on every route except /auth/*, /oauth/* and /healthz.
 * SSE (`GET /events`) may pass `?token=` because EventSource can't set headers.
 */
export function registerAuthHook(app: FastifyInstance, db: Db, now: () => Date) {
  app.decorateRequest('auth', null as unknown as AuthContext);
  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS' || isPublic(req.url)) return;
    let token = bearerToken(req);
    if (!token && req.method === 'GET' && (req.url.split('?')[0] ?? '') === '/events') {
      const q = (req.query as Record<string, unknown> | undefined)?.token;
      if (typeof q === 'string' && q) token = q;
    }
    if (!token) throw new HttpError(401, 'unauthorized', 'missing session token');
    const t = now();
    const [s] = await db
      .select({ id: sessions.id, userId: sessions.userId, lastUsedAt: sessions.lastUsedAt })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, t)));
    if (!s) throw new HttpError(401, 'unauthorized', 'invalid or expired session');
    req.auth = { userId: s.userId, sessionId: s.id };
    if (!s.lastUsedAt || t.getTime() - s.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await db.update(sessions).set({ lastUsedAt: t }).where(eq(sessions.id, s.id));
    }
  });
}

/** Default Google ID token verification (signature, expiry, issuer, audience). */
export function googleVerifier() {
  const client = new OAuth2Client();
  return async (idToken: string, audiences: string[]): Promise<GoogleIdentity> => {
    const ticket = await client.verifyIdToken({ idToken, audience: audiences });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error('ID token has no subject or email');
    return {
      sub: p.sub,
      email: p.email,
      emailVerified: p.email_verified === true,
      name: p.name ?? null,
    };
  };
}
