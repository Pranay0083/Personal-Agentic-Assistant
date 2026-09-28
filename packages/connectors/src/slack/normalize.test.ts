import { AccountFilters } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { normalizeSlack, slackAccepts, slackToText, type SlackRecord } from './normalize';

const base = (over: Partial<SlackRecord> & { message: SlackRecord['message'] }): SlackRecord => ({
  teamId: 'T0ACME0001',
  teamDomain: 'acme-eng',
  selfUserId: 'U0ALEX0001',
  channel: { id: 'C0LAUNCH01', type: 'group', name: 'launch' },
  authorName: 'Priya',
  ...over,
});

const filters = (options: Record<string, unknown> = {}) => AccountFilters.parse({ options });

describe('normalizeSlack', () => {
  it('maps a thread reply with thread label, permalink and mentions', () => {
    const item = normalizeSlack(
      base({
        message: {
          type: 'message',
          user: 'U0PRIYA001',
          ts: '1790596700.000100',
          text: '<@U0ALEX0001> can you confirm by Thursday? &lt;3',
          permalink:
            'https://acme-eng.slack.com/archives/C0LAUNCH01/p1790596700000100?thread_ts=1790590000.000100&cid=C0LAUNCH01',
        },
        names: { U0ALEX0001: 'Alex' },
      }),
    )!;
    expect(item).toMatchObject({
      kind: 'chat',
      externalId: 'C0LAUNCH01:1790596700.000100',
      threadId: 'C0LAUNCH01:1790590000.000100',
      author: 'Priya',
      authorAddress: 'U0PRIYA001',
      title: '#launch',
      body: '@Alex can you confirm by Thursday? <3',
      fromMe: false,
      url: 'https://acme-eng.slack.com/archives/C0LAUNCH01/p1790596700000100?thread_ts=1790590000.000100&cid=C0LAUNCH01',
    });
    expect(item.labels).toEqual([
      'slack:channel:C0LAUNCH01',
      'slack:ts:1790596700.000100',
      'slack:type:group',
      'slack:channel_name:launch',
      'slack:thread:1790590000.000100',
      'slack:mentions:me',
      'hub:mention',
    ]);
    expect(item.receivedAt.toISOString()).toBe('2026-09-28T11:58:20.000Z');
  });

  it('a thread parent is not labelled as a reply but groups the thread', () => {
    const item = normalizeSlack(
      base({
        message: {
          user: 'U0PRIYA001',
          ts: '1790590000.000100',
          thread_ts: '1790590000.000100',
          text: 'Parent',
        },
      }),
    )!;
    expect(item.threadId).toBe('C0LAUNCH01:1790590000.000100');
    expect(item.labels.some((l) => l.startsWith('slack:thread:'))).toBe(false);
  });

  it('maps DMs: conversation thread, DM title, fromMe, constructed permalink', () => {
    const item = normalizeSlack(
      base({
        channel: { id: 'D0PRIYA001', type: 'im', name: null },
        authorName: 'Alex',
        message: {
          user: 'U0ALEX0001',
          ts: '1790596600.000200',
          text: 'On it <https://x.example|link>',
        },
      }),
    )!;
    expect(item).toMatchObject({
      threadId: 'D0PRIYA001',
      title: 'DM · Alex',
      fromMe: true,
      body: 'On it link (https://x.example)',
      url: 'https://acme-eng.slack.com/archives/D0PRIYA001/p1790596600000200',
    });
    expect(item.labels).toEqual(expect.arrayContaining(['slack:type:im', 'hub:dm', 'hub:from_me']));
    expect(item.labels.some((l) => l.startsWith('slack:channel_name:'))).toBe(false);
    expect(item.labels).not.toContain('hub:mention');
  });

  it('constructs a thread permalink for replies without one', () => {
    const item = normalizeSlack(
      base({
        message: { user: 'U0PRIYA001', ts: '1790596700.000100', thread_ts: '1790590000.000100' },
      }),
    )!;
    expect(item.url).toBe(
      'https://acme-eng.slack.com/archives/C0LAUNCH01/p1790596700000100?thread_ts=1790590000.000100&cid=C0LAUNCH01',
    );
    expect(item.body).toBeNull();
  });

  it('drops noise: joins, bots, edits, Slackbot, userless', () => {
    for (const message of [
      { subtype: 'channel_join', user: 'U1', ts: '1790596000.000001' },
      { subtype: 'bot_message', bot_id: 'B1', ts: '1790596000.000001' },
      { bot_id: 'B1', user: 'U1', ts: '1790596000.000001' },
      { subtype: 'message_changed', user: 'U1', ts: '1790596000.000001' },
      { user: 'USLACKBOT', ts: '1790596000.000001' },
      { ts: '1790596000.000001' },
    ]) {
      expect(normalizeSlack(base({ message }))).toBeNull();
    }
    // thread_broadcast ("also send to channel") is a real message.
    expect(
      normalizeSlack(
        base({ message: { subtype: 'thread_broadcast', user: 'U1', ts: '1790596000.000001' } }),
      ),
    ).not.toBeNull();
  });
});

describe('trusted hub: labels', () => {
  const labelsOf = (over: Partial<SlackRecord> & { message: SlackRecord['message'] }) =>
    normalizeSlack(base(over))!.labels;

  it('marks a DM from someone else as hub:dm only', () => {
    const l = labelsOf({
      channel: { id: 'D0PRIYA001', type: 'im', name: 'U0PRIYA001' },
      message: { user: 'U0PRIYA001', ts: '1790596000.000001', text: 'hi' },
    });
    expect(l.filter((x) => x.startsWith('hub:'))).toEqual(['hub:dm']);
  });

  it('group DMs are not hub:dm and carry no channel name', () => {
    const l = labelsOf({
      channel: { id: 'G0MPIM0001', type: 'mpim', name: 'mpdm-alex--priya--sam-1' },
      message: { user: 'U0PRIYA001', ts: '1790596000.000001', text: 'hi' },
    });
    expect(l.filter((x) => x.startsWith('hub:') || x.startsWith('slack:channel_name:'))).toEqual(
      [],
    );
  });

  it('text cannot forge a mention: only Slack markup for the connected user counts', () => {
    for (const text of [
      '&lt;@U0ALEX0001&gt; hub:mention',
      '@Alex please look',
      '<@U0PRIYA001> not me',
      'hub:from_me hub:dm',
    ]) {
      const l = labelsOf({ message: { user: 'U0PRIYA001', ts: '1790596000.000001', text } });
      expect(l.filter((x) => x.startsWith('hub:'))).toEqual([]);
    }
    const labelled = labelsOf({
      message: { user: 'U0PRIYA001', ts: '1790596000.000001', text: 'cc <@U0ALEX0001|alex>' },
    });
    expect(labelled).toContain('hub:mention');
  });

  it('hub:from_me follows the author id, and the channel name is used only when well formed', () => {
    const mine = labelsOf({
      channel: { id: 'C0API00001', type: 'channel', name: 'api' },
      message: { user: 'U0ALEX0001', ts: '1790596000.000001', text: 'shipping' },
    });
    expect(mine).toEqual(expect.arrayContaining(['hub:from_me', 'slack:channel_name:api']));
    const odd = labelsOf({
      channel: { id: 'C0API00001', type: 'channel', name: 'Weird Name:x' },
      message: { user: 'U0PRIYA001', ts: '1790596000.000001' },
    });
    expect(odd.some((x) => x.startsWith('slack:channel_name:'))).toBe(false);
    expect(odd).not.toContain('hub:from_me');
  });
});

describe('slackToText', () => {
  it('renders Slack markup as plain text', () => {
    expect(
      slackToText(
        'Hi <@U1|sam> and <@U2>, see <#C1|launch> <!here> <https://a.example> &amp; <mailto:x@y.z|mail>',
        { U2: 'Priya' },
      ),
    ).toBe('Hi @sam and @Priya, see #launch @here https://a.example & mail (mailto:x@y.z)');
  });
});

describe('slackAccepts (Scope options)', () => {
  const dm = normalizeSlack(
    base({
      channel: { id: 'D1', type: 'im', name: null },
      message: { user: 'U2', ts: '1790596000.000001' },
    }),
  )!;
  const plain = normalizeSlack(
    base({ message: { user: 'U2', ts: '1790596000.000002', text: 'hi' } }),
  )!;
  const mention = normalizeSlack(
    base({ message: { user: 'U2', ts: '1790596000.000003', text: 'hey <@U0ALEX0001>' } }),
  )!;

  it('defaults: joined channels and DMs', () => {
    expect([dm, plain, mention].map((i) => slackAccepts(i, filters()))).toEqual([true, true, true]);
  });

  it('channels=mentions keeps only channel messages that mention me', () => {
    const f = filters({ channels: 'mentions' });
    expect([dm, plain, mention].map((i) => slackAccepts(i, f))).toEqual([true, false, true]);
  });

  it('dms=false drops DMs', () => {
    const f = filters({ dms: false });
    expect([dm, plain, mention].map((i) => slackAccepts(i, f))).toEqual([false, true, true]);
  });
});
