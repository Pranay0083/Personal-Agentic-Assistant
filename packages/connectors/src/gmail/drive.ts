import type { AccountFilters } from '@hub/shared';
import type { BackfillPage, DeltaResult, NormalizedItem } from '../types';
import { httpStatusOf } from './client';
import { GOOGLE_API, type GoogleRest } from './rest';

/**
 * Google Drive source: files shared with the user or edited by someone else. Metadata
 * only (drive.metadata.readonly): names, owners, who changed what. Never file content.
 * Delta = changes.getStartPageToken + changes.list; push = changes.watch channel.
 */

export type DriveUser = {
  kind?: string;
  displayName?: string;
  emailAddress?: string;
  me?: boolean;
  permissionId?: string;
};

export type DriveFile = {
  kind?: string;
  id: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  iconLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  sharedWithMeTime?: string;
  sharingUser?: DriveUser;
  lastModifyingUser?: DriveUser;
  owners?: DriveUser[];
  ownedByMe?: boolean;
  shared?: boolean;
  trashed?: boolean;
  driveId?: string;
};

export type DriveChange = {
  kind?: string;
  changeType?: string;
  type?: string;
  time?: string;
  removed?: boolean;
  fileId?: string;
  file?: DriveFile;
  driveId?: string;
};

export type DriveChangeList = {
  kind?: string;
  nextPageToken?: string;
  newStartPageToken?: string;
  changes?: DriveChange[];
};

export type DriveRecord = { change: DriveChange; accountEmail: string | null };

/** Metadata fields requested. No content, no export links, no thumbnails. */
export const DRIVE_FILE_FIELDS =
  'id,name,mimeType,webViewLink,iconLink,createdTime,modifiedTime,sharedWithMeTime,' +
  'sharingUser(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me),' +
  'owners(displayName,emailAddress,me),ownedByMe,shared,trashed,driveId';
const CHANGE_FIELDS = `nextPageToken,newStartPageToken,changes(changeType,removed,time,fileId,driveId,file(${DRIVE_FILE_FIELDS}))`;

/** Shared by changes.list and changes.watch: the watched change feed must match the listed one. */
export const DRIVE_CHANGE_PARAMS = {
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
} as const;

const FOLDER = 'application/vnd.google-apps.folder';
const MAX_PAGES_PER_DELTA = 10;

export async function driveStartPageToken(rest: GoogleRest): Promise<string> {
  const res = await rest<{ startPageToken?: string }>({
    url: `${GOOGLE_API.drive}/changes/startPageToken`,
    params: { supportsAllDrives: true },
  });
  if (!res.startPageToken) throw new Error('drive: no start page token');
  return res.startPageToken;
}

export async function driveDelta(
  rest: GoogleRest,
  opts: { cursor: string | null; accountEmail: string; pageSize?: number },
): Promise<DeltaResult<DriveRecord>> {
  if (!opts.cursor) return { records: [], cursor: await driveStartPageToken(rest) };
  const records: DriveRecord[] = [];
  let pageToken = opts.cursor;
  try {
    for (let i = 0; i < MAX_PAGES_PER_DELTA; i++) {
      const res = await rest<DriveChangeList>({
        url: `${GOOGLE_API.drive}/changes`,
        params: {
          pageToken,
          pageSize: opts.pageSize ?? 200,
          includeRemoved: true,
          spaces: 'drive',
          fields: CHANGE_FIELDS,
          ...DRIVE_CHANGE_PARAMS,
        },
      });
      for (const change of res.changes ?? []) {
        records.push({ change, accountEmail: opts.accountEmail });
      }
      if (res.newStartPageToken) return { records, cursor: res.newStartPageToken };
      if (!res.nextPageToken) return { records, cursor: pageToken };
      pageToken = res.nextPageToken;
    }
    // A change page token is also a valid cursor: continue from here on the next call.
    return { records, cursor: pageToken, hasMore: true };
  } catch (e) {
    const status = httpStatusOf(e);
    if (status === 404 || status === 410) {
      return { records: [], cursor: await driveStartPageToken(rest), fullResyncRequired: true };
    }
    throw e;
  }
}

/** Recently modified files, shaped like changes so normalize treats both the same. */
export async function driveBackfill(
  rest: GoogleRest,
  opts: { days: number; pageToken?: string; accountEmail: string; pageSize?: number },
  now = Date.now(),
): Promise<BackfillPage<DriveRecord>> {
  const since = new Date(now - Math.max(1, opts.days) * 86400_000).toISOString();
  const res = await rest<{ nextPageToken?: string; files?: DriveFile[] }>({
    url: `${GOOGLE_API.drive}/files`,
    params: {
      q: `modifiedTime > '${since}' and trashed = false`,
      orderBy: 'modifiedTime desc',
      pageSize: opts.pageSize ?? 100,
      pageToken: opts.pageToken,
      fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
      corpora: 'user',
      ...DRIVE_CHANGE_PARAMS,
    },
  });
  return {
    records: (res.files ?? []).map((file) => ({
      change: {
        kind: 'drive#change',
        changeType: 'file',
        removed: false,
        fileId: file.id,
        ...(file.modifiedTime ? { time: file.modifiedTime } : {}),
        file,
      },
      accountEmail: opts.accountEmail,
    })),
    nextPageToken: res.nextPageToken ?? null,
  };
}

const ms = (s: string | undefined) => {
  const v = s ? Date.parse(s) : NaN;
  return Number.isFinite(v) ? v : null;
};

/**
 * Maps a change to a NormalizedItem (kind `file`), or null when it is not something the
 * user needs to hear about: removals, trash, their own edits, folders nobody shared.
 */
export function normalizeDrive(rec: DriveRecord): NormalizedItem | null {
  const c = rec.change;
  const f = c.file;
  if (!f?.id || c.removed || f.trashed) return null;
  const ownedByMe = f.ownedByMe ?? f.owners?.some((o) => o.me) ?? false;
  const sharedAt = !ownedByMe ? ms(f.sharedWithMeTime) : null;
  const editor = f.lastModifyingUser;
  const editedAt = editor && editor.me === false ? ms(f.modifiedTime) : null;
  if (sharedAt === null && editedAt === null) return null;
  if (f.mimeType === FOLDER && sharedAt === null) return null;
  // Whichever happened last is the news.
  const shared = sharedAt !== null && (editedAt === null || sharedAt >= editedAt);
  const who = shared ? (f.sharingUser ?? f.owners?.[0]) : editor;
  const whoName = who?.displayName ?? who?.emailAddress ?? 'Someone';
  const name = f.name ?? 'Untitled';
  const labels = [
    `gdrive:file:${f.id}`,
    `gdrive:change:${shared ? 'shared' : 'edited'}`,
    `gdrive:owner:${ownedByMe ? 'me' : 'other'}`,
  ];
  if (f.mimeType) labels.push(`gdrive:mime:${f.mimeType}`);
  if (f.driveId) labels.push(`gdrive:drive:${f.driveId}`);
  const at = (shared ? sharedAt : editedAt) ?? ms(c.time) ?? 0;
  return {
    kind: 'file',
    externalId: f.id,
    threadId: f.id,
    author: who?.displayName ?? who?.emailAddress ?? null,
    authorAddress: who?.emailAddress?.toLowerCase() ?? null,
    title: name,
    summary: shared ? `${whoName} shared “${name}” with you` : `${whoName} edited “${name}”`,
    body: null,
    url: f.webViewLink ?? `https://drive.google.com/open?id=${encodeURIComponent(f.id)}`,
    labels,
    receivedAt: new Date(at),
    fromMe: false,
  };
}

/** Scope-screen option `drive.sharedOnly`: only files other people own and shared with you. */
export function driveAccepts(item: NormalizedItem, filters: AccountFilters): boolean {
  if (filters.options?.['drive.sharedOnly'] === true) {
    return item.labels.includes('gdrive:owner:other');
  }
  return true;
}
