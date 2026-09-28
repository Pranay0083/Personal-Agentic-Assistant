import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sessions } from '@hub/db';
import { hashToken } from '@hub/server';
import { DevSignInReq, GoogleSignInReq, type SignInRes } from '@hub/shared/api';
import { bearerToken, createSession, googleVerifier, requestTimezone, upsertUser } from '../auth';
import type { Ctx } from '../context';
import { HttpError, notFound, parse } from '../http';
import { toMe } from '../serialize';

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;
  const verifyGoogle = ctx.verifyGoogleIdToken ?? googleVerifier();

  app.post('/auth/dev', async (req): Promise<SignInRes> => {
    // Email-only sign-in exists for local development and never in production.
    if (!config.devAuth || config.production) throw notFound();
    const body = parse(DevSignInReq, req.body);
    const user = await upsertUser(db, { ...body, timezone: requestTimezone(req) });
    const token = await createSession(db, user.id, ctx.now());
    await ctx.audit({
      userId: user.id,
      principal: 'user',
      action: 'auth.sign_in',
      details: { method: 'dev' },
    });
    return { token, user: toMe(user) };
  });

  app.post('/auth/google', async (req): Promise<SignInRes> => {
    const { idToken } = parse(GoogleSignInReq, req.body);
    if (config.googleSigninClientIds.length === 0) {
      throw new HttpError(
        503,
        'google_signin_not_configured',
        'GOOGLE_SIGNIN_CLIENT_IDS is not set',
      );
    }
    let identity;
    try {
      identity = await verifyGoogle(idToken, config.googleSigninClientIds);
    } catch {
      throw new HttpError(401, 'invalid_id_token', 'Google ID token could not be verified');
    }
    if (!identity.emailVerified) {
      throw new HttpError(401, 'email_not_verified', 'Google account email is not verified');
    }
    const user = await upsertUser(db, {
      email: identity.email,
      name: identity.name,
      timezone: requestTimezone(req),
    });
    const token = await createSession(db, user.id, ctx.now());
    await ctx.audit({
      userId: user.id,
      principal: 'user',
      action: 'auth.sign_in',
      details: { method: 'google' },
    });
    return { token, user: toMe(user) };
  });

  app.post('/auth/sign-out', async (req, reply) => {
    const token = bearerToken(req);
    if (token) {
      const [s] = await db
        .delete(sessions)
        .where(eq(sessions.tokenHash, hashToken(token)))
        .returning({ userId: sessions.userId });
      if (s) await ctx.audit({ userId: s.userId, principal: 'user', action: 'auth.sign_out' });
    }
    return reply.code(204).send();
  });
}
