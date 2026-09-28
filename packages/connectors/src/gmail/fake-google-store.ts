import { randomBytes } from 'node:crypto';
import type { CalendarEvent, CalendarEventList } from './calendar';
import type { ChatMessage, ChatSpace, WorkspaceSubscription } from './chat';
import type { DriveChange, DriveChangeList, DriveFile } from './drive';
import { fixture } from './fixtures/index';

/**
 * Fake Google Workspace data per fake mailbox (Calendar events, Drive changes, Chat
 * spaces and messages, open watch channels and Workspace Events subscriptions), seeded
 * from the recorded fixtures. Lives inside FakeMailbox.google in the shared fake store.
 */

export type FakeChannel = {
  id: string;
  resourceId: string;
  source: 'calendar' | 'drive';
  /** The channel token Google would echo. Fake store only (it plays Google's part). */
  token: string;
  address: string;
  expiration: number;
};

export type FakeEventSubscription = WorkspaceSubscription & { name: string; topic: string };

export type FakeGoogle = {
  googleUserId: string;
  /** false = consumer account: Chat API answers 403. */
  workspace: boolean;
  calendar: { seq: number; minSeq: number; events: { seq: number; event: CalendarEvent }[] };
  drive: { seq: number; minSeq: number; changes: { seq: number; change: DriveChange }[] };
  chat: { spaces: ChatSpace[]; messages: ChatMessage[] };
  channels: FakeChannel[];
  eventSubscriptions: FakeEventSubscription[];
};

type SeedAccount = {
  googleUserId: string;
  workspace: boolean;
  calendar: string[];
  drive: string[];
  chatSpaces: string | null;
  chatMessages: string[];
};
type SeedFile = { recordedAt: string; accounts: Record<string, SeedAccount> };

const DAY = 86400_000;
export const fakeGoogleId = (n = 10) => randomBytes(n).toString('hex');

function shiftIso(s: string | undefined, ms: number): string | undefined {
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(Date.parse(`${s}T00:00:00Z`) + ms).toISOString().slice(0, 10);
  }
  const v = Date.parse(s);
  return Number.isFinite(v) ? new Date(v + ms).toISOString() : s;
}

function shiftEvent(e: CalendarEvent, ms: number): CalendarEvent {
  const t = (x: CalendarEvent['start']) =>
    x
      ? {
          ...x,
          ...(x.date ? { date: shiftIso(x.date, ms) } : {}),
          ...(x.dateTime ? { dateTime: shiftIso(x.dateTime, ms) } : {}),
        }
      : x;
  return {
    ...e,
    ...(e.created ? { created: shiftIso(e.created, ms) } : {}),
    ...(e.updated ? { updated: shiftIso(e.updated, ms) } : {}),
    ...(e.start ? { start: t(e.start) } : {}),
    ...(e.end ? { end: t(e.end) } : {}),
  };
}

function shiftFile(f: DriveFile, ms: number): DriveFile {
  return {
    ...f,
    ...(f.createdTime ? { createdTime: shiftIso(f.createdTime, ms) } : {}),
    ...(f.modifiedTime ? { modifiedTime: shiftIso(f.modifiedTime, ms) } : {}),
    ...(f.sharedWithMeTime ? { sharedWithMeTime: shiftIso(f.sharedWithMeTime, ms) } : {}),
  };
}

/** Seeds one mailbox's Google data. Times move by whole days so the demo stays current. */
export function seedFakeGoogle(email: string, now = Date.now()): FakeGoogle {
  const seed = fixture<SeedFile>('google-fake-seed.json');
  const acct = seed.accounts[email.toLowerCase()];
  const shift = Math.max(0, Math.floor((now - Date.parse(seed.recordedAt)) / DAY)) * DAY;
  const g: FakeGoogle = {
    googleUserId: acct?.googleUserId ?? String(100000000000000000000n + BigInt(email.length)),
    workspace: acct?.workspace ?? false,
    calendar: { seq: 100, minSeq: 100, events: [] },
    drive: { seq: 8840, minSeq: 8840, changes: [] },
    chat: { spaces: [], messages: [] },
    channels: [],
    eventSubscriptions: [],
  };
  if (!acct) return g;
  for (const file of acct.calendar) {
    for (const e of fixture<CalendarEventList>(file).items ?? []) {
      if (e.status === 'cancelled' && !e.summary) continue;
      g.calendar.events.push({ seq: g.calendar.seq, event: shiftEvent(e, shift) });
    }
  }
  for (const file of acct.drive) {
    for (const c of fixture<DriveChangeList>(file).changes ?? []) {
      g.drive.changes.push({
        seq: g.drive.seq,
        change: {
          ...c,
          ...(c.time ? { time: shiftIso(c.time, shift) } : {}),
          ...(c.file ? { file: shiftFile(c.file, shift) } : {}),
        },
      });
    }
  }
  if (acct.chatSpaces) {
    g.chat.spaces = (fixture<{ spaces: ChatSpace[] }>(acct.chatSpaces).spaces ?? []).map((s) => ({
      ...s,
      ...(s.lastActiveTime ? { lastActiveTime: shiftIso(s.lastActiveTime, shift) } : {}),
      ...(s.createTime ? { createTime: shiftIso(s.createTime, shift) } : {}),
    }));
  }
  for (const file of acct.chatMessages) {
    for (const m of fixture<{ messages?: ChatMessage[] }>(file).messages ?? []) {
      g.chat.messages.push({
        ...m,
        ...(m.createTime ? { createTime: shiftIso(m.createTime, shift) } : {}),
      });
    }
  }
  return g;
}

// ---- Mutations used by the fake:google script and tests ----

export type NewFakeCalendarEvent = {
  title: string;
  organizerEmail?: string;
  organizerName?: string;
  description?: string;
  location?: string;
  start?: Date;
  durationMinutes?: number;
};

export function addCalendarEvent(
  g: FakeGoogle,
  ownerEmail: string,
  input: NewFakeCalendarEvent,
  now = Date.now(),
): CalendarEvent {
  const id = fakeGoogleId(13);
  const start = input.start ?? new Date(Math.ceil((now + DAY) / 3600_000) * 3600_000);
  const end = new Date(start.getTime() + (input.durationMinutes ?? 30) * 60_000);
  const orgEmail = (input.organizerEmail ?? 'priya@company.example').toLowerCase();
  const self = orgEmail === ownerEmail.toLowerCase();
  const stamp = new Date(now).toISOString();
  const organizer = {
    email: orgEmail,
    ...(input.organizerName ? { displayName: input.organizerName } : {}),
    ...(self ? { self: true } : {}),
  };
  const event: CalendarEvent = {
    kind: 'calendar#event',
    etag: `"${now}000"`,
    id,
    status: 'confirmed',
    htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${ownerEmail}`).toString('base64url')}`,
    created: stamp,
    updated: stamp,
    summary: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    creator: organizer,
    organizer,
    start: { dateTime: start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: end.toISOString(), timeZone: 'UTC' },
    iCalUID: `${id}@google.com`,
    sequence: 0,
    attendees: [
      { ...organizer, organizer: true, responseStatus: 'accepted' },
      ...(self ? [] : [{ email: ownerEmail, self: true, responseStatus: 'needsAction' as const }]),
    ],
    reminders: { useDefault: true },
    eventType: 'default',
  };
  g.calendar.seq += 1;
  g.calendar.events.push({ seq: g.calendar.seq, event });
  return event;
}

export type NewFakeDriveShare = {
  name: string;
  fromEmail?: string;
  fromName?: string;
  mimeType?: string;
};

export function shareDriveFile(g: FakeGoogle, input: NewFakeDriveShare, now = Date.now()) {
  const id = `1${fakeGoogleId(16)}`;
  const stamp = new Date(now).toISOString();
  const user = {
    kind: 'drive#user',
    displayName: input.fromName ?? 'Priya Raman',
    me: false,
    emailAddress: (input.fromEmail ?? 'priya@company.example').toLowerCase(),
  };
  const mimeType = input.mimeType ?? 'application/vnd.google-apps.document';
  const change: DriveChange = {
    kind: 'drive#change',
    changeType: 'file',
    type: 'file',
    time: stamp,
    removed: false,
    fileId: id,
    file: {
      kind: 'drive#file',
      id,
      name: input.name,
      mimeType,
      webViewLink: `https://docs.google.com/document/d/${id}/edit?usp=drivesdk`,
      createdTime: stamp,
      modifiedTime: stamp,
      sharedWithMeTime: stamp,
      sharingUser: user,
      lastModifyingUser: user,
      owners: [user],
      ownedByMe: false,
      shared: true,
      trashed: false,
    },
  };
  g.drive.seq += 1;
  g.drive.changes.push({ seq: g.drive.seq, change });
  return change;
}

export type NewFakeChatMessage = {
  text: string;
  /** Space name (`spaces/...`) or display name; created when unknown. Default: first space. */
  space?: string;
  fromUserId?: string;
  thread?: string;
  /** Adds a USER_MENTION annotation for the mailbox owner, like an @-mention in Chat. */
  mentionOwner?: boolean;
};

export function addChatMessage(g: FakeGoogle, input: NewFakeChatMessage, now = Date.now()) {
  let space = input.space
    ? g.chat.spaces.find((s) => s.name === input.space || s.displayName === input.space)
    : g.chat.spaces[0];
  if (!space) {
    space = {
      name: `spaces/AAAA${fakeGoogleId(4)}`,
      type: 'ROOM',
      spaceType: 'SPACE',
      displayName: input.space ?? 'Team',
      createTime: new Date(now).toISOString(),
    };
    g.chat.spaces.push(space);
  }
  // Microsecond format like the real API; strictly increasing.
  const last = g.chat.messages.reduce((mx, m) => Math.max(mx, Date.parse(m.createTime ?? '')), 0);
  const at = Math.max(now, last + 1);
  const createTime = new Date(at).toISOString().replace('Z', '000Z');
  space.lastActiveTime = createTime;
  const id = fakeGoogleId(6);
  const thread = input.thread ?? `${space.name}/threads/${id}`;
  const message: ChatMessage = {
    name: `${space.name}/messages/${id}.${thread.split('/').pop()}`,
    sender: { name: `users/${input.fromUserId ?? '112233445566778899001'}`, type: 'HUMAN' },
    createTime,
    text: input.text,
    formattedText: input.text,
    thread: { name: thread },
    space: { name: space.name },
    argumentText: input.text,
    ...(input.mentionOwner
      ? {
          annotations: [
            {
              type: 'USER_MENTION',
              startIndex: 0,
              length: 0,
              userMention: {
                user: { name: `users/${g.googleUserId}`, type: 'HUMAN' },
                type: 'MENTION',
              },
            },
          ],
        }
      : {}),
    ...(input.thread ? { threadReply: true } : {}),
  };
  g.chat.messages.push(message);
  return { message, space };
}
