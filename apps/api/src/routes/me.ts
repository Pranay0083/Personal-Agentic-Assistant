import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { pushTokens, users } from '@hub/db';
import { UserSettings } from '@hub/shared';
import { PushTokenReq, UpdateMeReq, type Me } from '@hub/shared/api';
import { requestTimezone } from '../auth';
import type { Ctx } from '../context';
import { badRequest, isValidTimezone, parse } from '../http';
import { toMe, userSettings } from '../serialize';
import { syncAllStrictPolicies } from '../strict';

/**
 * Only the keys the client actually sent. zod v4 applies `.default()`s inside `.partial()`,
 * so the parsed object would otherwise reset every other field to its default.
 */
export function sentKeys<T extends object>(parsed: T | undefined, raw: unknown): Partial<T> {
  if (!parsed || !raw || typeof raw !== 'object') return {};
  const out: Partial<T> = {};
  for (const k of Object.keys(raw) as (keyof T)[]) {
    if (k in parsed && parsed[k] !== undefined) out[k] = parsed[k];
  }
  return out;
}

export function meRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/me', async (req): Promise<Me> => toMe(await ctx.user(req.auth.userId)));

  app.patch('/me', async (req): Promise<Me> => {
    const userId = req.auth.userId;
    const body = parse(UpdateMeReq, req.body);
    const current = await ctx.user(userId);
    const set: Partial<typeof users.$inferInsert> = {};

    if (body.name !== undefined) set.name = body.name;
    if (body.timezone !== undefined) {
      if (!isValidTimezone(body.timezone)) throw badRequest('timezone: unknown IANA timezone');
      set.timezone = body.timezone;
    } else if (current.timezone === 'UTC') {
      // Default the timezone from the app's hint until the user picks one.
      const hint = requestTimezone(req);
      if (hint && hint !== 'UTC') set.timezone = hint;
    }
    if (body.role !== undefined) set.role = body.role;
    if (body.preset !== undefined) set.preset = body.preset;
    if (body.strictPersonal !== undefined) set.strictPersonal = body.strictPersonal;
    if (body.onboarded && !current.onboardedAt) set.onboardedAt = ctx.now();
    if (body.settings !== undefined) {
      const rawSettings = (req.body as { settings?: unknown }).settings;
      const patch = sentKeys(body.settings, rawSettings);
      set.settings = UserSettings.parse({ ...userSettings(current.settings), ...patch });
    }

    let updated = current;
    if (Object.keys(set).length > 0) {
      const [u] = await db.update(users).set(set).where(eq(users.id, userId)).returning();
      if (u) updated = u;
    }
    if (body.strictPersonal !== undefined && body.strictPersonal !== current.strictPersonal) {
      await syncAllStrictPolicies(db, userId, ctx.now());
    }
    const changed = Object.keys(set);
    if (changed.length > 0) {
      await ctx.audit({
        userId,
        principal: 'user',
        action: 'settings.updated',
        details: { fields: changed },
      });
    }
    return toMe(updated);
  });

  app.post('/me/push-tokens', async (req, reply) => {
    const userId = req.auth.userId;
    const body = parse(PushTokenReq, req.body);
    await db
      .insert(pushTokens)
      .values({ userId, token: body.token, platform: body.platform, createdAt: ctx.now() })
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: { userId, platform: body.platform, createdAt: sql`excluded.created_at` },
      });
    return reply.code(204).send();
  });
}
