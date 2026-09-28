import { describe, expect, it } from 'vitest';
import { fenceUntrusted } from './fence';
import { FakeProvider } from './providers/fake';

const email = (from: string, subject: string, body: string) =>
  fenceUntrusted(`From: ${from}\nSubject: ${subject}\n\n${body}`, 'email');

async function run(agent: string, content: string, extra = '') {
  const fake = new FakeProvider();
  const res = await fake.generate({
    model: 'claude-haiku-4-5',
    agent,
    system: 'Return JSON.',
    messages: [
      { role: 'user', content: `Reference date: 2026-09-28 (Monday)\n${extra}\n${content}` },
    ],
  });
  return { res, json: JSON.parse(res.text) as Record<string, unknown> };
}

const meera = email(
  'Meera Shah <meera@acme.com>',
  'Q3 deck',
  'Hi! Can you send the Q3 deck by Thursday?',
);

describe('FakeProvider', () => {
  it('triages a request as needs_you with a summary', async () => {
    const { res, json } = await run('triage', meera);
    expect(res.provider).toBe('fake');
    expect(json.bucket).toBe('needs_you');
    expect(json.expectsReply).toBe(true);
    expect(json.summary).toBe('Meera asked you to send the Q3 deck by Thursday.');
    expect(json.statusLabel).toBe('Needs reply');
  });

  it('triages newsletters as ignore and plain updates as fyi', async () => {
    const promo = await run(
      'triage',
      email('Shop <no-reply@shop.com>', '50% off', 'Sale ends soon. Unsubscribe here.'),
    );
    expect(promo.json.bucket).toBe('ignore');
    const fyi = await run(
      'triage',
      email('Raj <raj@acme.com>', 'Launch update', 'The launch went fine.'),
    );
    expect(fyi.json.bucket).toBe('fyi');
  });

  it('learns from rejected tasks for the same sender', async () => {
    const feedback = fenceUntrusted(
      JSON.stringify([{ verdict: 'rejected', title: 'Send the Q2 deck', from: 'meera@acme.com' }]),
      'feedback',
    );
    const { json } = await run('triage', meera, feedback);
    expect(json.bucket).toBe('fyi');
  });

  it('extracts a task due Thursday', async () => {
    const { json } = await run('extractor', meera);
    expect(json.tasks).toEqual([
      {
        title: 'Send the Q3 deck to Meera',
        due: '2026-10-01',
        dueTime: null,
        project: 'Q3',
        confidence: 0.9,
      },
    ]);
  });

  it("extracts the user's own promises in promise mode", async () => {
    const { json } = await run(
      'extractor',
      email('Me <me@acme.com>', 'Re: budget', "Sure, I'll share the budget sheet tomorrow EOD."),
      'Mode: promises',
    );
    const tasks = json.tasks as { title: string; due: string; dueTime: string }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Share the budget sheet');
    expect(tasks[0]!.due).toBe('2026-09-29');
    expect(tasks[0]!.dueTime).toBe('17:00');
  });

  it('drafts a reply and a topic', async () => {
    const { json } = await run('reply', meera);
    expect(json.body).toContain("I'll send the Q3 deck by Thursday");
    expect(json.body).toMatch(/^Hi Meera,/);
    expect(json.topic).toBe('Q3 deck timeline');
  });

  it('writes a brief like the design', async () => {
    const data = fenceUntrusted(
      JSON.stringify({
        tasks: [
          { title: 'Send the Q3 deck to Meera', due: 'Thursday', from: 'Meera', overdue: false },
        ],
        needsYou: [{ from: 'Raj', title: 'Offsite', summary: 'Raj asked you to book the venue.' }],
      }),
      'brief-data',
    );
    const { json } = await run('brief', data);
    expect(json.headline).toBe('Two things matter today. The Q3 deck is the big one.');
    expect(json.bullets).toEqual([
      'Meera needs the Q3 deck by Thursday. Not started yet.',
      'Raj asked you to book the venue.',
    ]);
  });

  it("replies in the first person without echoing the sender's pronouns", async () => {
    const { json } = await run(
      'reply',
      email(
        'Meera Iyer <meera@acme.com>',
        'Board pack',
        'Could you send me the board pack by Wednesday?',
      ),
    );
    expect(json.body).toContain("I'll send you the board pack by Wednesday");
    expect(json.body).not.toMatch(/send me/);
  });

  it('drops indirect objects and keeps own promises unattributed in the brief', async () => {
    const data = fenceUntrusted(
      JSON.stringify({
        tasks: [
          { title: 'Send Meera the board pack', due: 'Wednesday', from: 'Meera', overdue: false },
          { title: 'Get Morgan the signed MSA', due: 'Wednesday', from: null, overdue: false },
        ],
      }),
      'brief-data',
    );
    const { json } = await run('brief', data);
    expect(json.headline).toBe('Two things matter today. The board pack is the big one.');
    expect(json.bullets).toEqual([
      'Meera needs the board pack by Wednesday. Not started yet.',
      'Get Morgan the signed MSA by Wednesday.',
    ]);
  });

  it('strips "by end of day <weekday>" from promise titles', async () => {
    const { json } = await run(
      'extractor',
      email('Me <me@acme.com>', 'Re: MSA', "I'll get you the signed MSA by end of day Wednesday."),
      'Mode: promises',
    );
    const tasks = json.tasks as { title: string; due: string; dueTime: string }[];
    expect(tasks[0]!.title).not.toMatch(/wednesday/i);
    expect(tasks[0]!.due).toBe('2026-09-30');
    expect(tasks[0]!.dueTime).toBe('17:00');
  });

  it('answers free-form questions with text', async () => {
    const res = await new FakeProvider().generate({
      model: 'x',
      agent: 'ask',
      system: '',
      messages: [{ role: 'user', content: meera }],
    });
    expect(res.text).toContain('Offline demo model');
    expect(res.text).toContain('Q3 deck');
  });

  it('can simulate failures', async () => {
    const fake = new FakeProvider({ failWith: () => new Error('boom') });
    await expect(
      fake.generate({ model: 'x', system: '', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('boom');
  });
});

const item = (kind: string, from: string, subject: string, body: string) =>
  fenceUntrusted(`From: ${from}\nSubject: ${subject}\n\n${body}`, kind);

describe('FakeProvider: Phase 5 item kinds', () => {
  it('a Jira issue assigned to you that blocks people (from signals)', async () => {
    const ticket = item('ticket', 'Arjun', 'PROJ-482 Payment retries failing', 'Retries fail.');
    const facts =
      'Source: atlassian ticket\nReference: PROJ-482 (Jira issue)\nSignals: assigned to you, blocking 2 people';
    const t = await run('triage', ticket, facts);
    expect(t.json).toMatchObject({
      bucket: 'needs_you',
      statusLabel: 'Blocking 2 people',
      summary: 'Assigned to you. Two teammates are waiting on it.',
      expectsReply: false,
    });
    const e = await run('extractor', ticket, facts);
    expect((e.json.tasks as { title: string }[])[0]!.title).toBe('Unblock PROJ-482');
  });

  it('reads the same cues from the text when the connector set no signals', async () => {
    const ticket = item(
      'ticket',
      'Jira',
      'PROJ-482 Payment retries failing',
      'Assigned to you. Two teammates are waiting on it.',
    );
    const t = await run('triage', ticket);
    expect(t.json).toMatchObject({ bucket: 'needs_you', statusLabel: 'Blocking 2 people' });
    const e = await run('extractor', ticket);
    expect((e.json.tasks as { title: string }[])[0]!.title).toBe('Unblock PROJ-482');
  });

  it('a pull request review request becomes "Review <repo>#<n>"', async () => {
    const pr = item('code', 'Dev <dev@acme.com>', 'Fix retry backoff', 'Adds jitter.');
    const facts = 'Reference: api#231 (pull request)\nSignals: review requested from you';
    const t = await run('triage', pr, facts);
    expect(t.json).toMatchObject({
      bucket: 'needs_you',
      statusLabel: 'Review requested',
      summary: 'Dev requested your review on api#231.',
    });
    const e = await run('extractor', pr, facts);
    expect((e.json.tasks as { title: string }[])[0]!.title).toBe('Review api#231');
  });

  it('status changes on tickets are FYI', async () => {
    const t = await run('triage', item('ticket', 'Arjun', 'PROJ-470', 'Moved to Done by Arjun.'));
    expect(t.json).toMatchObject({
      bucket: 'fyi',
      statusLabel: 'FYI',
      summary: 'Moved to Done by Arjun.',
    });
  });

  it('calendar events are FYI unless they need an RSVP', async () => {
    const plain = await run(
      'triage',
      item('event', 'Raj <raj@acme.com>', 'Design review', 'Updated: moved to 3pm. Can you join?'),
    );
    expect(plain.json).toMatchObject({ bucket: 'fyi', expectsReply: false });
    const invite = item('event', 'Raj <raj@acme.com>', 'Offsite planning', 'Thu 10:00');
    const rsvp = await run('triage', invite, 'Signals: RSVP needed');
    expect(rsvp.json).toMatchObject({
      bucket: 'needs_you',
      statusLabel: 'RSVP needed',
      summary: 'Raj invited you to Offsite planning. RSVP needed.',
    });
    const e = await run('extractor', invite, 'Signals: RSVP needed');
    expect((e.json.tasks as { title: string }[])[0]!.title).toBe('RSVP to Offsite planning');
  });

  it('direct mentions in chat need you and draft a short chat reply', async () => {
    const msg = item('chat', 'Priya', '#api', 'Where does the API spec live?');
    const t = await run('triage', msg, 'Source: slack chat\nSignals: mentions you');
    expect(t.json).toMatchObject({
      bucket: 'needs_you',
      statusLabel: 'Needs reply',
      expectsReply: true,
      summary: 'Priya asked: Where does the API spec live?',
    });
    const chatter = await run('triage', item('chat', 'Sam', '#random', 'Lunch is here.'));
    expect(chatter.json).toMatchObject({ bucket: 'fyi', statusLabel: 'FYI' });
    const r = await run('reply', msg);
    expect(r.json.body).not.toMatch(/^Hi /);
    expect(r.json.body).not.toMatch(/\n\nThanks$/);
  });

  it('notes and files are FYI unless they ask something', async () => {
    const note = await run(
      'triage',
      item('note', 'Dana', 'Q4 plan', 'Updated the roadmap section.'),
    );
    expect(note.json).toMatchObject({ bucket: 'fyi', summary: 'Updated the roadmap section.' });
    const file = await run(
      'triage',
      item('file', 'Dana', 'Q3 deck', 'Dana commented: can you review slide 4 by Friday?'),
    );
    expect(file.json).toMatchObject({ bucket: 'needs_you', expectsReply: false });
  });
});
