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
 * Idempotency: the issue entity property `hub.exec.<sha256(idempotencyKey)[:32]>` records
 * progress. `findExecuted` (read token; the write consent cannot read issues) reads it back.
 * - transition: before the transition we write `{state:'pending'}`, after it the final
 *   `{result}`. An issue in the target status counts as done only with that marker present;
 *   "already in the target status" alone never does (someone else may have moved it).
 *   When the transition screen has no comment field we transition, write
 *   `{state:'transitioned'}`, then comment separately. A retry after a crash between the
 *   two finds the `transitioned` marker and posts only the missing comment.
 * - comment: the comment itself carries a `hub.exec` comment property with the same
 *   hash, so a lookup also scans the latest comments.
 */

export const JIRA_ACTIONS = ['jira.transition', 'jira.comment'] as const;
export type JiraAction = (typeof JIRA_ACTIONS)[number];

export const execPropertyKey = (idempotencyKey: string) =>
  `hub.exec.${sha256Hex(idempotencyKey).slice(0, 32)}`;
const keyHash = (idempotencyKey: string) => sha256Hex(idempotencyKey).slice(0, 32);

type Marker = {
  action: string;
  at: string;
  /** Set once the action is complete. */
  result?: ExecuteResult;
  /** Progress of an incomplete transition. */
  state?: 'pending' | 'transitioned';
};

async function putMarker(
  api: AtlassianClient,
  issueKey: string,
  idempotencyKey: string,
  value: Marker,
) {
  await api.jira(`${issuePath(issueKey)}/properties/${execPropertyKey(idempotencyKey)}`, {
    method: 'PUT',
    body: value,
  });
}

const mark = (
  api: AtlassianClient,
  issueKey: string,
  idempotencyKey: string,
  action: string,
  result: ExecuteResult,
  now: number,
) => putMarker(api, issueKey, idempotencyKey, { action, at: new Date(now).toISOString(), result });

/**
 * Progress a lookup found and a following execute resumes from. The write token cannot
 * read the marker, so findExecuted (read token, same attempt, same process) hands it over.
 */
export type JiraResume = { issueKey: string; transitioned: true };

export async function executeJira(
  api: AtlassianClient,
  action: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  now: number,
  resume?: JiraResume | null,
): Promise<ExecuteResult> {
  if (action === 'jira.transition') {
    const p = JiraTransitionPayload.parse(payload);
    const at = new Date(now).toISOString();
    const result: ExecuteResult = {
      externalId: p.issueKey,
      issueKey: p.issueKey,
      transitionId: p.transitionId,
      toStatus: p.toStatus,
    };
    if (resume?.transitioned && resume.issueKey === p.issueKey) {
      // An earlier attempt moved the issue and crashed before its separate comment.
      if (p.comment) await postComment(api, p.issueKey, p.comment, idempotencyKey);
      await mark(api, p.issueKey, idempotencyKey, action, result, now);
      return result;
    }
    await putMarker(api, p.issueKey, idempotencyKey, { action, at, state: 'pending' });
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
      // move the issue, record that, then comment separately (with the comment marker).
      await api.jira(`${issuePath(p.issueKey)}/transitions`, { method: 'POST', body: base });
      await putMarker(api, p.issueKey, idempotencyKey, { action, at, state: 'transitioned' });
      await postComment(api, p.issueKey, p.comment, idempotencyKey);
    }
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
): { issueKey: string; toStatus?: string; transitionId?: string; hasComment?: boolean } | null {
  if (!payload) return null;
  if (action === 'jira.transition') {
    const p = JiraTransitionPayload.safeParse(payload);
    return p.success
      ? {
          issueKey: p.data.issueKey,
          toStatus: p.data.toStatus,
          transitionId: p.data.transitionId,
          hasComment: !!p.data.comment,
        }
      : null;
  }
  if (action === 'jira.comment') {
    const p = JiraCommentPayload.safeParse(payload);
    return p.success ? { issueKey: p.data.issueKey } : null;
  }
  return null;
}

async function findMarkedComment(
  api: AtlassianClient,
  issueKey: string,
  idempotencyKey: string,
): Promise<JiraComment | null> {
  const page = await api.jira<{ comments: JiraComment[] } | null>(
    `${issuePath(issueKey)}/comment`,
    { query: { orderBy: '-created', maxResults: 50, expand: 'properties' }, allow: [404] },
  );
  const h = keyHash(idempotencyKey);
  return (
    page?.comments.find((c) =>
      c.properties?.some(
        (p) => p.key === 'hub.exec' && (p.value as { k?: unknown } | null)?.k === h,
      ),
    ) ?? null
  );
}

/**
 * Looks up an earlier execution. `onResume` receives the progress of a transition that
 * moved the issue but has not posted its separate comment yet (the lookup then reports
 * "not executed" so the executor calls execute, which posts only the comment).
 */
export async function findJiraExecuted(
  api: AtlassianClient,
  action: string,
  idempotencyKey: string,
  target: { issueKey: string; toStatus?: string; transitionId?: string; hasComment?: boolean },
  onResume?: (r: JiraResume) => void,
): Promise<ExecuteResult | null> {
  const prop = await api.jira<{ key: string; value: Marker } | null>(
    `${issuePath(target.issueKey)}/properties/${execPropertyKey(idempotencyKey)}`,
    { allow: [404] },
  );
  const marker = prop?.value ?? null;
  if (marker?.result?.externalId) return marker.result;

  if (action === 'jira.transition') {
    const done = (extra: Record<string, unknown>): ExecuteResult => ({
      externalId: target.issueKey,
      issueKey: target.issueKey,
      ...(target.transitionId ? { transitionId: target.transitionId } : {}),
      ...(target.toStatus ? { toStatus: target.toStatus } : {}),
      ...extra,
    });
    if (marker?.state === 'transitioned') {
      // Moved; the separate comment may or may not have been posted.
      if (!target.hasComment) return done({});
      const hit = await findMarkedComment(api, target.issueKey, idempotencyKey);
      if (hit) return done({ commentId: hit.id });
      onResume?.({ issueKey: target.issueKey, transitioned: true });
      return null;
    }
    // Without our marker the status proves nothing: someone else may have moved it.
    if (marker?.state !== 'pending' || !target.toStatus) return null;
    const issue = await api.jira<JiraIssue | null>(issuePath(target.issueKey), {
      query: { fields: 'status' },
      allow: [404],
    });
    const status = issue?.fields.status?.name;
    if (status && status.toLowerCase() === target.toStatus.toLowerCase()) {
      // We started this transition and the issue reached the target: the combined
      // transition-with-comment request is atomic, so it went through.
      return done({ toStatus: status, alreadyInStatus: true });
    }
    return null;
  }

  if (action === 'jira.comment') {
    const hit = await findMarkedComment(api, target.issueKey, idempotencyKey);
    if (hit) return { externalId: hit.id, issueKey: target.issueKey, commentId: hit.id };
  }
  return null;
}
