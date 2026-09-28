import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { accounts, grants, mcpClients, policies, type Db } from '@hub/db';
import {
  ACTION_RESOURCES,
  DATA_RESOURCES,
  PROVIDER_RESOURCES,
  parsePrincipal,
  resolveLevel,
  type GrantRule,
  type LevelSource,
  type PolicyContext,
  type PolicyRule,
} from '@hub/policy';
import { Preset, PrincipalKey, type PolicyLevel } from '@hub/shared';
import { SetPolicyReq, type PermissionsRes } from '@hub/shared/api';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest, idParam, notFound, parse } from '../http';
import { toGrant } from '../serialize';
import { upsertPolicies } from '../strict';

type Row = PermissionsRes['data'][number];

export const AGENT_PRINCIPALS: { key: string; label: string }[] = [
  { key: 'agent:triage', label: 'Triage agent' },
  { key: 'agent:reply', label: 'Reply agent' },
  { key: 'agent:brief', label: 'Brief agent' },
  { key: 'agent:extractor', label: 'Task extractor' },
];

const PROVIDER_LABEL: Record<string, string> = {
  gmail: 'Gmail',
  microsoft: 'Microsoft 365',
  slack: 'Slack',
  atlassian: 'Jira & Confluence',
  notion: 'Notion',
  github: 'GitHub',
};

/** Data row label per (provider, resource), e.g. Gmail's calendar is "Google Calendar". */
const DATA_LABEL: Record<string, Record<string, string>> = {
  gmail: { email: 'Gmail', calendar: 'Google Calendar', files: 'Google Drive' },
  microsoft: { email: 'Outlook', chat: 'Teams', calendar: 'Outlook Calendar', files: 'OneDrive' },
  slack: { chat: 'Slack', files: 'Slack files' },
  atlassian: { tickets: 'Jira', notes: 'Confluence' },
  notion: { notes: 'Notion' },
  github: { code: 'GitHub', tickets: 'GitHub issues' },
};

const DATA_SCOPE: Record<string, string> = {
  email: 'Mail in the folders you chose',
  chat: 'Channels and messages',
  tickets: 'Issues and comments',
  notes: 'Pages and notes',
  calendar: 'Titles and times',
  files: 'File names and links',
  code: 'Repositories, issues and pull requests',
};

const ACTION_LABEL: Record<string, string> = {
  'task.create': 'Create tasks',
  'draft.write': 'Write drafts',
  'message.send': 'Send messages',
  'ticket.update': 'Update tickets',
  'email.label': 'Label and archive',
};

/** The contract reports four sources; the engine distinguishes a few more. */
function rowSource(s: LevelSource): Row['source'] {
  switch (s) {
    case 'grant':
    case 'account':
    case 'provider':
      return s;
    case 'global':
      return 'provider';
    default:
      return 'preset';
  }
}

async function principalsFor(db: Db, userId: string) {
  const clients = await db
    .select({ id: mcpClients.id, name: mcpClients.name })
    .from(mcpClients)
    .where(and(eq(mcpClients.userId, userId), isNull(mcpClients.revokedAt)))
    .orderBy(asc(mcpClients.createdAt));
  // MCP principal key is `mcp:<mcp_clients.id>` (agreed with apps/mcp).
  return [...AGENT_PRINCIPALS, ...clients.map((c) => ({ key: `mcp:${c.id}`, label: c.name }))];
}

const Query = z.object({ principal: z.string().optional() });

export function permissionRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/permissions', async (req): Promise<PermissionsRes> => {
    const userId = req.auth.userId;
    const q = parse(Query, req.query);
    const principals = await principalsFor(db, userId);
    const key = q.principal ?? AGENT_PRINCIPALS[0]!.key;
    if (!principals.some((p) => p.key === key)) throw badRequest('principal: unknown principal');
    const principal = parsePrincipal(key, userId);

    const user = await ctx.user(userId);
    const preset = Preset.safeParse(user.preset).success ? (user.preset as Preset) : 'balanced';
    const now = ctx.now();
    const accts = await db
      .select({ id: accounts.id, provider: accounts.provider, nickname: accounts.nickname })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .orderBy(asc(accounts.createdAt), asc(accounts.id));
    const pols: PolicyRule[] = (
      await db.select().from(policies).where(eq(policies.userId, userId))
    ).map((r) => ({ ...r, level: r.level as PolicyLevel }));
    const grantRows = await db
      .select()
      .from(grants)
      .where(and(eq(grants.userId, userId), isNull(grants.revokedAt), gt(grants.expiresAt, now)));
    const grantRules: GrantRule[] = grantRows.map((g) => ({ ...g, level: g.level as PolicyLevel }));

    const context = (account: PolicyContext['account']): PolicyContext => ({
      user: { id: userId, preset, paused: user.paused },
      account,
      // Provider-wide rows must not see any account's overrides.
      policies: pols.filter((p) =>
        account && p.accountId ? p.accountId === account.id : !p.accountId,
      ),
      grants: grantRules,
      now,
    });

    const data: Row[] = [];
    const actions: Row[] = [];
    const providers = [...new Set(accts.map((a) => a.provider))];
    for (const provider of providers) {
      const held = PROVIDER_RESOURCES[provider] ?? [];
      const dataRes = DATA_RESOURCES.filter((r) => held.includes(r));
      const actionRes = ACTION_RESOURCES.filter(
        (r) => held.includes(r) || r === 'task.create' || r === 'draft.write',
      );
      const providerCtx = context({ id: `provider:${provider}`, userId, provider });
      const providerAccounts = accts.filter((a) => a.provider === provider);

      const rowsFor = (resource: string, isData: boolean) => {
        const out: Row[] = [];
        const base = resolveLevel(providerCtx, principal, resource);
        const label = isData
          ? (DATA_LABEL[provider]?.[resource] ?? PROVIDER_LABEL[provider] ?? provider)
          : (ACTION_LABEL[resource] ?? resource);
        const scopeText = (level: PolicyLevel) =>
          isData
            ? level === 'none'
              ? 'Only with a temporary grant'
              : (DATA_SCOPE[resource] ?? resource)
            : (PROVIDER_LABEL[provider] ?? provider);
        out.push({
          resource: resource as Row['resource'],
          provider,
          accountId: null,
          label,
          scope: scopeText(base.level),
          level: base.level,
          source: rowSource(base.source),
        });
        // Accounts whose effective level differs (e.g. a personal account) get their own row.
        for (const a of providerAccounts) {
          const r = resolveLevel(context({ id: a.id, userId, provider }), principal, resource);
          if (r.level === base.level && r.source === base.source) continue;
          out.push({
            resource: resource as Row['resource'],
            provider,
            accountId: a.id,
            label: `${label} · ${a.nickname}`,
            scope: scopeText(r.level),
            level: r.level,
            source: rowSource(r.source),
          });
        }
        return out;
      };
      for (const r of dataRes) data.push(...rowsFor(r, true));
      for (const r of actionRes) actions.push(...rowsFor(r, false));
    }

    const known = new Set<string>([...DATA_RESOURCES, ...ACTION_RESOURCES]);
    return {
      principal: key,
      preset,
      principals,
      data,
      actions,
      grants: grantRows.filter((g) => g.principal === key && known.has(g.scope)).map(toGrant),
    };
  });

  app.put('/policies', async (req, reply) => {
    const userId = req.auth.userId;
    const body = parse(SetPolicyReq, req.body);
    if (!PrincipalKey.safeParse(body.principal).success || body.principal === 'user') {
      throw badRequest('principal: invalid');
    }
    let provider = body.provider;
    if (body.accountId) {
      const account = await ctx.account(userId, body.accountId);
      // Account rules are keyed by account only, matching the strict-personal rows they override.
      provider = null;
      if (
        !(PROVIDER_RESOURCES[account.provider] ?? []).includes(body.resource) &&
        !isHubAction(body.resource)
      ) {
        throw badRequest(`${account.provider} has no ${body.resource}`);
      }
    } else if (provider) {
      if (!(provider in PROVIDER_RESOURCES)) throw badRequest('provider: unknown');
      if (
        !(PROVIDER_RESOURCES[provider] ?? []).includes(body.resource) &&
        !isHubAction(body.resource)
      ) {
        throw badRequest(`${provider} has no ${body.resource}`);
      }
    }
    if (
      (DATA_RESOURCES as string[]).includes(body.resource) &&
      !['none', 'read', 'never'].includes(body.level)
    ) {
      throw badRequest('level: data resources take none, read or never');
    }
    await upsertPolicies(
      db,
      userId,
      [
        {
          principal: body.principal,
          provider,
          accountId: body.accountId,
          resource: body.resource,
          level: body.level,
        },
      ],
      ctx.now(),
    );
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'policy.set',
      target: body.accountId
        ? `account:${body.accountId}`
        : provider
          ? `provider:${provider}`
          : null,
      details: { principal: body.principal, resource: body.resource, level: body.level },
    });
    return reply.code(204).send();
  });

  app.delete('/grants/:id', async (req, reply) => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const [g] = await db
      .update(grants)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(grants.id, id), eq(grants.userId, userId), isNull(grants.revokedAt)))
      .returning();
    if (!g) {
      const [exists] = await db
        .select({ id: grants.id })
        .from(grants)
        .where(and(eq(grants.id, id), eq(grants.userId, userId)));
      if (!exists) throw notFound('grant');
      return reply.code(204).send();
    }
    await ctx.audit({
      userId,
      principal: 'user',
      action: 'grant.revoked',
      target: `grant:${id}`,
      details: { principal: g.principal, scope: g.scope },
    });
    return reply.code(204).send();
  });
}

const isHubAction = (r: string) => r === 'task.create' || r === 'draft.write';
