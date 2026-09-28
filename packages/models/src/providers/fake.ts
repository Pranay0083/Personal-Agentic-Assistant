import type { GenerateRequest, GenerateResult, ModelProvider } from '../types';
import {
  actionPhrase,
  capitalize,
  dueFor,
  estimateTokens,
  expectsReply,
  firstName,
  isNoise,
  lowerFirst,
  objectOf,
  outsideFences,
  parseItem,
  promiseSentences,
  readFences,
  requestSentences,
  stripSubject,
  taskTitle,
  type Fence,
  type ParsedItem,
} from './fake-text';

/**
 * Deterministic offline model for the local demo and tests (`MODEL_PROVIDER=fake`).
 *
 * Prompt contract (what the agents in apps/workers send):
 * - Untrusted content arrives in `fenceUntrusted()` blocks. The item block (label = item
 *   kind, e.g. `email`) starts with `From:` and `Subject:` headers, a blank line, then text.
 * - Triage may add a `feedback` block: JSON `[{verdict:"confirmed"|"rejected", title, from}]`.
 * - Brief sends a `brief-data` block: JSON `{tasks:[{title,due,from,overdue}], needsYou:[{from,title,summary}]}`.
 * - Trusted lines outside the fences: `Reference date: YYYY-MM-DD` and optionally `Mode: promises`.
 * The request's `agent` field selects the output shape. Output is JSON for agents, text otherwise.
 */
export class FakeProvider implements ModelProvider {
  readonly kind = 'fake' as const;

  constructor(
    private readonly opts: {
      /** Return an error to simulate a provider failure for this request. */
      failWith?: (req: GenerateRequest) => Error | undefined;
    } = {},
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const err = this.opts.failWith?.(req);
    if (err) throw err;
    const prompt = req.messages.map((m) => m.content).join('\n');
    const fences = readFences(prompt);
    const meta = outsideFences(`${req.system}\n${prompt}`);
    const ref = /^Reference date:\s*(\d{4}-\d{2}-\d{2})/m.exec(meta)?.[1] ?? null;

    let out: unknown;
    switch (req.agent) {
      case 'triage':
        out = fakeTriage(fences, ref);
        break;
      case 'extractor':
        out = fakeExtract(fences, ref, /^Mode:\s*promises/m.test(meta));
        break;
      case 'brief':
        out = fakeBrief(fences);
        break;
      case 'reply':
        out = fakeReply(fences, ref);
        break;
      default:
        out = undefined;
    }
    const text = out === undefined ? fakeAnswer(fences) : JSON.stringify(out);
    return {
      text,
      toolCalls: [],
      usage: {
        inputTokens: estimateTokens(req.system + prompt),
        outputTokens: estimateTokens(text),
      },
      model: req.model,
      provider: 'fake',
    };
  }
}

function itemFence(fences: Fence[]): ParsedItem {
  const f = fences.find((x) => !['feedback', 'brief-data'].includes(x.label)) ?? {
    label: 'content',
    content: '',
  };
  return parseItem(f.content);
}

type Feedback = { verdict: 'confirmed' | 'rejected'; title: string; from: string | null };

function readFeedback(fences: Fence[]): Feedback[] {
  const f = fences.find((x) => x.label === 'feedback');
  if (!f) return [];
  try {
    const v = JSON.parse(f.content) as unknown;
    return Array.isArray(v) ? (v as Feedback[]) : [];
  } catch {
    return [];
  }
}

function fakeTriage(fences: Fence[], ref: string | null) {
  const item = itemFence(fences);
  const who = firstName(item.fromName, item.fromAddress) ?? 'Someone';
  const requests = requestSentences(item.body);
  const text = `${item.subject}\n${item.body}`;

  let bucket: 'needs_you' | 'fyi' | 'ignore' = 'fyi';
  let reason = 'informational';
  if (isNoise(item)) {
    bucket = 'ignore';
    reason = 'automated or promotional';
  } else if (requests.length > 0) {
    bucket = 'needs_you';
    reason = 'contains a direct request';
  }

  // Learn from feedback: a sender whose tasks were rejected more often than confirmed
  // no longer lands in needs_you.
  if (bucket === 'needs_you') {
    const sender = (item.fromAddress ?? item.fromName ?? '').toLowerCase();
    const fb = readFeedback(fences).filter((f) => (f.from ?? '').toLowerCase() === sender);
    const rejected = fb.filter((f) => f.verdict === 'rejected').length;
    const confirmed = fb.filter((f) => f.verdict === 'confirmed').length;
    if (sender && rejected > confirmed) {
      bucket = 'fyi';
      reason = 'similar requests from this sender were marked "Not a task"';
    }
  }

  const reply = bucket === 'needs_you' && expectsReply(item.body);
  let summary: string;
  if (bucket === 'needs_you') {
    const first = requests[0]!;
    const action = lowerFirst(actionPhrase(first) || stripSubject(item.subject));
    const due = dueFor(first, item.body, ref);
    summary = `${who} asked you to ${action}${due ? ` ${due.phrase}` : ''}.`;
  } else {
    summary = stripSubject(item.subject) || item.body.split('\n')[0]!.slice(0, 100);
  }

  let statusLabel: string | null = null;
  const blocking =
    /\bblock(?:ing|ed)\s+(\d+|two|three|four|five)\s+(people|folks|teams?|engineers|devs)\b/i.exec(
      text,
    );
  if (bucket === 'needs_you') {
    statusLabel = blocking
      ? `Blocking ${wordNum(blocking[1]!)} people`
      : reply
        ? 'Needs reply'
        : 'Needs you';
  } else if (bucket === 'fyi') statusLabel = 'FYI';

  return { bucket, summary: summary.slice(0, 200), statusLabel, expectsReply: reply, reason };
}

function wordNum(s: string): number {
  const w: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  return w[s.toLowerCase()] ?? Number(s);
}

function projectOf(item: ParsedItem): string | null {
  const tag = /\[([^\]]{2,30})\]/.exec(item.subject)?.[1];
  if (tag) return tag.trim();
  const q = /\b(Q[1-4])\b/.exec(`${item.subject} ${item.body}`)?.[1];
  return q ?? null;
}

function fakeExtract(fences: Fence[], ref: string | null, promises: boolean) {
  const item = itemFence(fences);
  const who = firstName(item.fromName, item.fromAddress);
  const project = projectOf(item);
  const source = promises
    ? promiseSentences(item.body)
    : isNoise(item)
      ? []
      : requestSentences(item.body);
  const tasks = source.slice(0, 3).map((s) => {
    const due = dueFor(s, source.length === 1 ? item.body : s, ref);
    const title = promises
      ? capitalize(
          actionPhrase(
            s.replace(/^.*?\bI(?:'ll| will| can| am going to|'m going to)\s+/i, 'please '),
          ),
        )
      : taskTitle(s, who);
    return {
      title: title || stripSubject(item.subject) || 'Follow up',
      due: due?.date ?? null,
      dueTime: due?.time ?? null,
      project,
      confidence: due ? 0.9 : 0.75,
    };
  });
  return { tasks };
}

type BriefData = {
  tasks?: { title: string; due?: string | null; from?: string | null; overdue?: boolean }[];
  needsYou?: { from?: string | null; title?: string | null; summary?: string | null }[];
};

const COUNT_WORDS = ['No', 'One', 'Two', 'Three'];

function fakeBrief(fences: Fence[]) {
  let data: BriefData;
  try {
    data = JSON.parse(fences.find((f) => f.label === 'brief-data')?.content ?? '{}') as BriefData;
  } catch {
    data = {};
  }
  const tasks = data.tasks ?? [];
  const bullets: string[] = [];
  for (const t of tasks.slice(0, 3)) {
    const action = t.title.replace(/\s+to\s+[A-Z]\w*$/, '');
    const due = t.due ? ` ${t.overdue ? 'was due' : 'by'} ${t.due}` : '';
    if (t.from) {
      bullets.push(
        `${t.from} needs ${objectOf(action)}${due}. ${t.overdue ? 'Overdue.' : 'Not started yet.'}`,
      );
    } else {
      bullets.push(`${capitalize(action)}${due}.${t.overdue ? ' Overdue.' : ''}`);
    }
  }
  for (const n of data.needsYou ?? []) {
    if (bullets.length >= 3) break;
    const what = n.summary || n.title;
    if (what) bullets.push(n.from && !what.startsWith(n.from) ? `${n.from}: ${what}` : what);
  }
  const n = bullets.length;
  let headline = 'Nothing urgent today.';
  if (n > 0) {
    headline = `${COUNT_WORDS[n]} thing${n === 1 ? '' : 's'} matter${n === 1 ? 's' : ''} today.`;
    const big = tasks[0];
    if (big) {
      const obj = objectOf(big.title.replace(/\s+to\s+[A-Z]\w*$/, ''));
      headline += ` ${capitalize(obj.replace(/^(the|a|an)\s+/i, 'The '))} is the big one.`;
    }
  }
  return { headline, bullets };
}

function fakeReply(fences: Fence[], ref: string | null) {
  const item = itemFence(fences);
  const who = firstName(item.fromName, item.fromAddress);
  const req = requestSentences(item.body)[0];
  let line = "Thanks for the note. I'll take a look and get back to you shortly.";
  let topic = stripSubject(item.subject) || 'your message';
  if (req) {
    const action = actionPhrase(req);
    const due = dueFor(req, item.body, ref);
    if (action) {
      line = `Yes, I'll ${lowerFirst(action)}${due ? ` ${due.phrase}` : ''}.`;
      if (due) {
        topic = `${stripSubject(item.subject) || capitalize(objectOf(action))} timeline`;
      }
    }
  }
  const body = `Hi${who ? ` ${who}` : ''},\n\n${line}\n\nThanks`;
  return { body, topic: topic.slice(0, 60) };
}

function fakeAnswer(fences: Fence[]): string {
  if (fences.length === 0) return 'Offline demo model: no context was provided.';
  const lines = fences.slice(0, 5).map((f) => {
    const it = parseItem(f.content);
    return `- ${stripSubject(it.subject) || it.body.split('\n')[0]!.slice(0, 80)}`;
  });
  return `Offline demo model. Based on ${fences.length} item(s) in your context:\n${lines.join('\n')}`;
}
