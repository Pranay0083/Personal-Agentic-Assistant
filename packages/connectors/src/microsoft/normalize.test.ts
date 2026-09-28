import { describe, expect, it } from 'vitest';
import type {
  GraphChat,
  GraphChatMessage,
  GraphCollection,
  GraphDriveItem,
  GraphEvent,
  GraphMessage,
  MsOwner,
} from './graph-types';
import { eventInstant, htmlToText, microsoftAccepts, normalizeMicrosoft } from './normalize';
import { WORK_ID, defaultFilters, fx } from './test-helpers';

const owner: MsOwner = { id: WORK_ID, addresses: ['avery.chen@contoso.example'] };
const first = <T>(file: string, i = 0) => fx<GraphCollection<T>>(file).value![i]!;

describe('normalize mail', () => {
  it('maps an HTML inbox message with Outlook references and stripped body', () => {
    const m = first<GraphMessage>('mail-delta-inbox-1.json');
    const item = normalizeMicrosoft({ source: 'mail', folder: 'inbox', message: m, owner })!;
    expect(item).toMatchObject({
      kind: 'email',
      externalId: m.id,
      threadId: 'AAQkAGI2TGuLAAAQAQAMfixtureConv1',
      author: 'Priya Raman',
      authorAddress: 'priya.raman@contoso.example',
      title: 'Budget sign-off for Q4',
      url: m.webLink,
      fromMe: false,
    });
    // The reply agent replies to `outlook:id:` and threads on threadId = conversationId.
    expect(item.labels[0]).toBe(`outlook:id:${m.id}`);
    expect(item.labels).not.toContain('hub:from_me');
    expect(item.receivedAt.toISOString()).toBe('2026-09-28T08:15:02.000Z');
    expect(item.body).toBe(
      'Hi Avery,\nCan you approve the Q4 budget by Friday? The sheet is attached.\nThanks & regards,\nPriya',
    );
    expect(item.body).not.toMatch(/<|p\{margin/);
    expect(item.labels).toEqual(
      expect.arrayContaining([
        `outlook:id:${m.id}`,
        'outlook:conversation:AAQkAGI2TGuLAAAQAQAMfixtureConv1',
        'outlook:folder:inbox',
        'outlook:category:Finance',
        'outlook:msgid:<SN6PR01MB1234ABCD@SN6PR01MB1234.prod.outlook.example>',
      ]),
    );
  });

  it('marks Sent Items and the owner address as fromMe; drops drafts and removals', () => {
    const sent = first<GraphMessage>('mail-delta-sent.json');
    const s = normalizeMicrosoft({ source: 'mail', folder: 'sent', message: sent, owner })!;
    expect(s.fromMe).toBe(true);
    expect(s.labels).toContain('hub:from_me');
    // Owner's own message found in the Inbox (e.g. a self-sent note).
    expect(
      normalizeMicrosoft({ source: 'mail', folder: 'inbox', message: sent, owner })!.fromMe,
    ).toBe(true);
    const removed = first<GraphMessage>('mail-delta-inbox-1.json', 1);
    expect(
      normalizeMicrosoft({ source: 'mail', folder: 'inbox', message: removed, owner }),
    ).toBeNull();
    expect(
      normalizeMicrosoft({
        source: 'mail',
        folder: 'inbox',
        message: { ...sent, isDraft: true },
        owner,
      }),
    ).toBeNull();
  });
});

describe('normalize calendar', () => {
  it('maps an event with UTC start/end labels and organizer', () => {
    const e = first<GraphEvent>('calendar-delta.json');
    const item = normalizeMicrosoft({ source: 'calendar', event: e, owner })!;
    expect(item).toMatchObject({
      kind: 'event',
      externalId: 'AAMkADNkNmAAAFfixtureEvent1',
      title: 'Q4 planning',
      author: 'Priya Raman',
      authorAddress: 'priya.raman@contoso.example',
      fromMe: false,
      url: e.webLink,
      body: 'Agenda:\nroadmap\nhiring\nbudget',
    });
    expect(item.labels).toEqual(
      expect.arrayContaining([
        'mscal:event:AAMkADNkNmAAAFfixtureEvent1',
        'mscal:start:2026-09-30T15:00:00.000Z',
        'mscal:end:2026-09-30T16:00:00.000Z',
        'mscal:response:tentativelyAccepted',
      ]),
    );
    expect(item.summary).toContain('@ Room 4.12');
    expect(item.labels).not.toContain('hub:rsvp_needed');
    expect(
      normalizeMicrosoft({
        source: 'calendar',
        event: first<GraphEvent>('calendar-delta.json', 2),
        owner,
      }),
    ).toBeNull();
  });

  it('flags an unanswered invite from someone else with hub:rsvp_needed', () => {
    const invite = first<GraphEvent>('calendar-delta.json', 1);
    const item = normalizeMicrosoft({ source: 'calendar', event: invite, owner })!;
    expect(item.labels).toEqual(
      expect.arrayContaining([
        'hub:rsvp_needed',
        'mscal:start:2026-10-01T09:00:00.000Z',
        'mscal:end:2026-10-01T09:30:00.000Z',
      ]),
    );
    // Own events and cancelled ones never need an RSVP.
    const own = normalizeMicrosoft({
      source: 'calendar',
      event: { ...invite, isOrganizer: true },
      owner,
    })!;
    expect(own.labels).not.toContain('hub:rsvp_needed');
    expect(own.labels).toContain('hub:from_me');
    const cancelled = normalizeMicrosoft({
      source: 'calendar',
      event: { ...invite, isCancelled: true },
      owner,
    })!;
    expect(cancelled.labels).not.toContain('hub:rsvp_needed');
  });

  it('reads Graph dateTimeTimeZone values', () => {
    expect(eventInstant({ dateTime: '2026-09-30T15:00:00.0000000', timeZone: 'UTC' })).toBe(
      '2026-09-30T15:00:00.000Z',
    );
    expect(
      eventInstant({ dateTime: '2026-09-30T15:00:00+02:00', timeZone: 'W. Europe Standard Time' }),
    ).toBe('2026-09-30T13:00:00.000Z');
    expect(eventInstant(null)).toBeNull();
  });
});

describe('normalize teams', () => {
  const chat = first<GraphChat>('chats.json');
  const ref = {
    id: chat.id,
    topic: chat.topic ?? null,
    chatType: chat.chatType ?? null,
    webUrl: chat.webUrl ?? null,
  };

  it('maps a chat message with the chat reference and plain text', () => {
    const m = first<GraphChatMessage>('chat-messages.json');
    const item = normalizeMicrosoft({ source: 'teams', chat: ref, message: m, owner })!;
    expect(item).toMatchObject({
      kind: 'chat',
      externalId: `${chat.id}/1790587800000`,
      threadId: chat.id,
      author: 'Priya Raman',
      authorAddress: null,
      title: 'Chat with Priya Raman',
      body: 'Avery can you review the pricing slide before 3pm?',
      url: chat.webUrl,
      fromMe: false,
    });
    expect(item.labels).toEqual(
      expect.arrayContaining([
        `teams:chat:${chat.id}`,
        'teams:message:1790587800000',
        'teams:chatType:oneOnOne',
        'hub:dm',
        'hub:mention',
      ]),
    );
    expect(item.labels).not.toContain('hub:from_me');
  });

  it('sets hub:mention only from mention entities, and hub:dm only for 1:1 chats', () => {
    const m = first<GraphChatMessage>('chat-messages.json');
    const other = {
      ...m,
      mentions: [{ id: 0, mentionText: 'Jordan', mentioned: { user: { id: 'someone-else' } } }],
    };
    const inGroup = normalizeMicrosoft({
      source: 'teams',
      chat: { ...ref, chatType: 'group', topic: 'Launch crew' },
      message: other,
      owner,
    })!;
    expect(inGroup.labels).not.toContain('hub:mention');
    expect(inGroup.labels).not.toContain('hub:dm');
    expect(inGroup.title).toBe('Launch crew');
    // Text that merely contains the name is not a mention.
    const textOnly = {
      ...m,
      mentions: [],
      body: { contentType: 'text', content: '@Avery Chen hello' },
    };
    expect(
      normalizeMicrosoft({ source: 'teams', chat: ref, message: textOnly, owner })!.labels,
    ).not.toContain('hub:mention');
  });

  it('marks the owner as fromMe and skips system events', () => {
    const mine = first<GraphChatMessage>('chat-messages.json', 1);
    const own = normalizeMicrosoft({ source: 'teams', chat: ref, message: mine, owner })!;
    expect(own.fromMe).toBe(true);
    expect(own.labels).toContain('hub:from_me');
    const system = first<GraphChatMessage>('chat-messages.json', 2);
    expect(normalizeMicrosoft({ source: 'teams', chat: ref, message: system, owner })).toBeNull();
    expect(
      normalizeMicrosoft({
        source: 'teams',
        chat: ref,
        message: { ...mine, deletedDateTime: '2026-09-28T09:40:00Z' },
        owner,
      }),
    ).toBeNull();
  });
});

describe('normalize onedrive', () => {
  it('maps file metadata only and skips folders, root and deletions', () => {
    const items = fx<GraphCollection<GraphDriveItem>>('drive-delta.json').value!;
    const out = items.map((item) => normalizeMicrosoft({ source: 'onedrive', item, owner }));
    expect(out.filter(Boolean)).toHaveLength(1);
    const f = out[2]!;
    expect(f).toMatchObject({
      kind: 'file',
      externalId: '01BYE5RZ4CPC5XBOTZCFD2CT7SWFFS4IHC',
      title: 'Q3 Board Deck.pptx',
      author: 'Priya Raman',
      authorAddress: 'priya.raman@contoso.example',
      body: null,
      fromMe: false,
    });
    expect(f.summary).toBe('Edited by Priya Raman · /Board');
    expect(f.labels).toEqual(
      expect.arrayContaining([
        'onedrive:item:01BYE5RZ4CPC5XBOTZCFD2CT7SWFFS4IHC',
        'onedrive:drive:b!fixture-drive',
      ]),
    );
  });
});

describe('accepts', () => {
  const inbox = normalizeMicrosoft({
    source: 'mail',
    folder: 'inbox',
    message: first<GraphMessage>('mail-delta-inbox-1.json'),
    owner,
  })!;
  const sent = normalizeMicrosoft({
    source: 'mail',
    folder: 'sent',
    message: first<GraphMessage>('mail-delta-sent.json'),
    owner,
  })!;

  it('applies inbox/sent', () => {
    expect(microsoftAccepts(inbox, defaultFilters(), 'mail')).toBe(true);
    expect(microsoftAccepts(inbox, defaultFilters({ inbox: false }), 'mail')).toBe(false);
    expect(microsoftAccepts(sent, defaultFilters({ inbox: false }), 'mail')).toBe(true);
    expect(microsoftAccepts(sent, defaultFilters({ sent: false }), 'mail')).toBe(false);
  });

  it('applies source toggles and defaults', () => {
    expect(microsoftAccepts(inbox, defaultFilters({ sources: { mail: false } }), 'mail')).toBe(
      false,
    );
    const file = normalizeMicrosoft({
      source: 'onedrive',
      item: fx<GraphCollection<GraphDriveItem>>('drive-delta.json').value![2]!,
      owner,
    })!;
    expect(microsoftAccepts(file, defaultFilters())).toBe(true);
    expect(microsoftAccepts(file, defaultFilters({ sources: { onedrive: false } }))).toBe(false);
    expect(microsoftAccepts(file, defaultFilters(), 'channels', { channels: false })).toBe(false);
  });
});

describe('htmlToText', () => {
  it('drops styles and scripts and decodes entities', () => {
    expect(
      htmlToText('<style>x{}</style><script>alert(1)</script><p>a &amp; b&#39;s&nbsp;c</p>'),
    ).toBe("a & b's c");
  });
});
