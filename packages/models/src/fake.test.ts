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
