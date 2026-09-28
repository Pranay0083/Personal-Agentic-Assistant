import { ConnectorError, MissingScopeError } from '../errors';
import type { AccessKind, ConnectorContext, ConnectorInfo } from '../types';
import { GMAIL_SCOPES as S } from './config';

export const GOOGLE_SOURCES = ['mail', 'calendar', 'drive', 'chat'] as const;
export type GoogleSource = (typeof GOOGLE_SOURCES)[number];

/** Scopes each source needs. Google lets users untick any of them on the consent screen. */
export const SOURCE_SCOPES: Record<GoogleSource, string[]> = {
  mail: [S.readonly],
  calendar: [S.calendarEvents],
  drive: [S.driveMetadata],
  chat: [S.chatMessages, S.chatSpaces],
};

const IDENTITY_SCOPES = [
  S.openid,
  S.email,
  S.userinfoEmail,
  'profile',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/** The read consent (connect flow). Never a write scope. */
export const READ_SCOPES = [
  S.readonly,
  S.calendarEvents,
  S.driveMetadata,
  S.chatMessages,
  S.chatSpaces,
  S.openid,
  S.email,
];
const READ_SOURCE_SCOPES = new Set(Object.values(SOURCE_SCOPES).flat());

/**
 * The write consent (executor only). gmail.send is the only Gmail write; openid+email
 * identify the mailbox so the API can check the same Google account granted it.
 */
export const WRITE_SCOPES = [S.send, S.openid, S.email];

/** Write scopes named explicitly so the refusal is obvious; anything off the read list is refused too. */
export const KNOWN_WRITE_SCOPES = [
  S.send,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.insert',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/chat.spaces',
];

export const splitScopes = (scope: string | undefined) =>
  (scope ?? '').split(/\s+/).filter(Boolean);

/**
 * Checks what a consent actually granted.
 * - read: any non-empty subset of the source read scopes; any other scope (a write scope
 *   in particular) rejects the whole grant. Returns the granted scopes to record as
 *   `identities[0].meta.grantedScopes`.
 * - write: must include gmail.send.
 */
export function checkGrantedScopes(scope: string | undefined, access: AccessKind): string[] {
  const granted = splitScopes(scope);
  const set = new Set(granted);
  if (access === 'write') {
    if (!set.has(S.send)) throw new MissingScopeError('gmail', [S.send]);
    return granted;
  }
  if (!granted.some((s) => READ_SOURCE_SCOPES.has(s))) {
    throw new MissingScopeError('gmail', [...READ_SOURCE_SCOPES]);
  }
  const extra = granted.filter((s) => !READ_SOURCE_SCOPES.has(s) && !IDENTITY_SCOPES.includes(s));
  if (extra.length) {
    // include_granted_scopes=false should make this impossible; refuse rather than store it.
    const write = extra.some((s) => KNOWN_WRITE_SCOPES.includes(s));
    throw new ConnectorError(
      'gmail',
      write
        ? 'read grant unexpectedly includes write scopes'
        : 'read grant includes unexpected scopes',
    );
  }
  return granted;
}

export function sourceOf(ctx: Pick<ConnectorContext, 'source'>): GoogleSource {
  const s = ctx.source ?? 'mail';
  if (!(GOOGLE_SOURCES as readonly string[]).includes(s)) {
    throw new ConnectorError('gmail', `unknown source ${s}`);
  }
  return s as GoogleSource;
}

/**
 * Whether the stored grant covers the source. Unknown (no scope string, no recorded
 * grant) counts as granted, so older mail-only contexts behave as before.
 */
export function sourceGranted(ctx: ConnectorContext, source: GoogleSource): boolean {
  const recorded = Array.isArray(ctx.meta?.grantedScopes)
    ? (ctx.meta.grantedScopes as string[])
    : null;
  const granted = recorded ?? (ctx.tokens.scope ? splitScopes(ctx.tokens.scope) : null);
  if (!granted) return true;
  return SOURCE_SCOPES[source].every((s) => granted.includes(s));
}

/** Catalog entry for the Connect and Scope screens. */
export const GMAIL_INFO: ConnectorInfo = {
  name: 'Google',
  covers: 'Gmail, Calendar, Drive, Chat · one sign-in each',
  multiAccountNote: null,
  sources: [
    {
      id: 'mail',
      label: 'Gmail',
      hint: 'Inbox and sent mail',
      kind: 'email',
      defaultOn: true,
      scopes: SOURCE_SCOPES.mail,
    },
    {
      id: 'calendar',
      label: 'Calendar',
      hint: 'Events you organize or are invited to',
      kind: 'event',
      defaultOn: true,
      scopes: SOURCE_SCOPES.calendar,
    },
    {
      id: 'drive',
      label: 'Drive',
      hint: 'Files shared with you or edited by others. Names and activity only, never file contents',
      kind: 'file',
      defaultOn: true,
      scopes: SOURCE_SCOPES.drive,
    },
    {
      id: 'chat',
      label: 'Google Chat',
      hint: 'Messages in your spaces and DMs. Google Workspace accounts only',
      kind: 'chat',
      defaultOn: true,
      scopes: SOURCE_SCOPES.chat,
    },
  ],
  options: [
    {
      key: 'drive.sharedOnly',
      label: 'Only files shared with you',
      hint: 'Skip edits to files you own',
      type: 'boolean',
      default: false,
    },
    {
      key: 'calendar.hideDeclined',
      label: 'Hide declined events',
      hint: null,
      type: 'boolean',
      default: true,
    },
  ],
  writeActions: ['gmail.send'],
};
