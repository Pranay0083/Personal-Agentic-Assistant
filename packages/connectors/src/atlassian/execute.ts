import { JiraCommentPayload, JiraTransitionPayload } from '@hub/shared';
import { ConnectorError } from '../errors';
import { sha256Hex } from '../lib/crypto';
import type { ExecuteResult } from '../types';
import type { JiraComment, JiraIssue } from './api-types';
import { PROVIDER, issuePath, type AtlassianClient } from './client';
import { textToAdf } from './text';

/**
 * Jira writes (executor only, write-scope token).
 *
 * Idempotency: after a successful write we set the issue entity property
 * `hub.exec.<sha256(idempotencyKey)[:32]>` = `{ action, result }`. `findExecuted` reads it
 * back. The window between the write and the marker is covered per action:
 * - transition: an issue already in the target status counts as done;
 * - comment: the comment itself carries a `hub.exec` comment property with the same
 *   hash, so a lookup also scans the latest comments.
 */

export const JIRA_ACTIONS = ['jira.transition', 'jira.comment'] as const;
export type JiraAction = (typeof JIRA_ACTIONS)[number];

export const execPropertyKey = (idempotencyKey: string) =>
  `hub.exec.${sha256Hex(idempotencyKey).slice(0, 32)}`;
const keyHash = (idempotencyKey: string) => sha256Hex(idempotencyKey).slice(0, 32);

type Marker = { action: string; at: string; result: ExecuteResult };

async function mark(
  api: AtlassianClient,
  issueKey: string,
  idempotencyKey: string,
  action: string,
  result: ExecuteResult,
  now: number,
) {
  const value: Marker = { action, at: new Date(now).toISOString(), result };
  await api.jira(`${issuePath(issueKey)}/properties/${execPropertyKey(idempotencyKey)}`, {
    method: 'PUT',
    body: value,
  });
}

export async function executeJira(
  api: AtlassianClient,
  action: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  now: number,
): Promise<ExecuteResult> {
  if (action === 'jira.transition') {
    const p = JiraTransitionPayload.parse(payload);
    const base = { transition: { id: p.transitionId } };
    const withComment = p.comment
      ? { ...base, update: { comment: [{ add: { body: textToAdf(p.comment) } }] } }
      : base;
    // 204 No Content on success.
    try {
      await api.jira(`${issuePath(p.issueKey)}/transitions`, { method: 'POST', body: withComment });
    } catch (e) {
      if (!p.comment || !(e instanceof ConnectorError) || e.status !== 400) throw e;
      // 400 with a comment usually means the transition screen has no comment field:
      // move the issue, then comment separately (carrying the same comment marker).
      await api.jira(`${issuePath(p.issueKey)}/transitions`, { method: 'POST', body: base });
      await postComment(api, p.issueKey, p.comment, idempotencyKey);
    }
    const result: ExecuteResult = {
      externalId: p.issueKey,
      issueKey: p.issueKey,
      transitionId: p.transitionId,
      toStatus: p.toStatus,
    };
    await mark(api, p.issueKey, idempotencyKey, action, result, now);
    return result;
  }
  if (action === 'jira.comment') {
    const p = JiraCommentPayload.parse(payload);
    const c = await postComment(api, p.issueKey, p.body, idempotencyKey);
    const result: ExecuteResult = { externalId: c.id, issueKey: p.issueKey, commentId: c.id };
    await mark(api, p.issueKey, idempotencyKey, action, result, now);
    return result;
  }
  throw new ConnectorError(PROVIDER, `unsupported action ${action}`);
}

async function postComment(
  api: AtlassianClient,
  issueKey: string,
  text: string,
  idempotencyKey: string,
): Promise<JiraComment> {
  const c = await api.jira<JiraComment>(`${issuePath(issueKey)}/comment`, {
    method: 'POST',
    body: {
      body: textToAdf(text),
      properties: [{ key: 'hub.exec', value: { k: keyHash(idempotencyKey) } }],
    },
  });
  if (!c?.id) throw new ConnectorError(PROVIDER, 'comment returned no id');
  return c;
}

/** The issue key (and target status) the lookup needs; taken from the proposal payload. */
export function lookupTarget(
  action: string,
  payload: Record<string, unknown> | undefined,
): { issueKey: string; toStatus?: string; transitionId?: string } | null {
  if (!payload) return null;
  if (action === 'jira.transition') {
    const p = JiraTransitionPayload.safeParse(payload);
    return p.success
      ? { issueKey: p.data.issueKey, toStatus: p.data.toStatus, transitionId: p.data.transitionId }
      : null;
  }
  if (action === 'jira.comment') {
    const p = JiraCommentPayload.safeParse(payload);
    return p.success ? { issueKey: p.data.issueKey } : null;
  }
  return null;
}

export async function findJiraExecuted(
  api: AtlassianClient,
  action: string,
  idempotencyKey: string,
  target: { issueKey: string; toStatus?: string; transitionId?: string },
): Promise<ExecuteResult | null> {
  const prop = await api.jira<{ key: string; value: Marker } | null>(
    `${issuePath(target.issueKey)}/properties/${execPropertyKey(idempotencyKey)}`,
    { allow: [404] },
  );
  if (prop?.value?.result?.externalId) return prop.value.result;

  if (action === 'jira.transition' && target.toStatus) {
    const issue = await api.jira<JiraIssue | null>(issuePath(target.issueKey), {
      query: { fields: 'status' },
      allow: [404],
    });
    const status = issue?.fields.status?.name;
    if (status && status.toLowerCase() === target.toStatus.toLowerCase()) {
      return {
        externalId: target.issueKey,
        issueKey: target.issueKey,
        toStatus: status,
        alreadyInStatus: true,
      };
    }
    return null;
  }

  if (action === 'jira.comment') {
    const page = await api.jira<{ comments: JiraComment[] } | null>(
      `${issuePath(target.issueKey)}/comment`,
      { query: { orderBy: '-created', maxResults: 50, expand: 'properties' }, allow: [404] },
    );
    const h = keyHash(idempotencyKey);
    const hit = page?.comments.find((c) =>
      c.properties?.some(
        (p) => p.key === 'hub.exec' && (p.value as { k?: unknown } | null)?.k === h,
      ),
    );
    if (hit) return { externalId: hit.id, issueKey: target.issueKey, commentId: hit.id };
  }
  return null;
}
