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
  sentences,
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
 * - Trusted lines outside the fences: `Reference date: YYYY-MM-DD`, optionally `Mode: promises`,
 *   and item facts: `Source: <provider> <kind>`, `Reference: api#231 (pull request)`,
 *   `Signals: mentions you, review requested from you, assigned to you, blocking 2 people, …`.
 *   Without signal lines (demo data), the same cues are read from the text.
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

    const facts = readFacts(meta);
    let out: unknown;
    switch (req.agent) {
      case 'triage':
        out = fakeTriage(fences, ref, facts);
        break;
      case 'extractor':
        out = fakeExtract(fences, ref, /^Mode:\s*promises/m.test(meta), facts);
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

function itemFence(fences: Fence[]): ParsedItem & { kind: string } {
  const f = fences.find((x) => !['feedback', 'brief-data'].includes(x.label)) ?? {
    label: 'content',
    content: '',
  };
  return { ...parseItem(f.content), kind: f.label };
}

type Facts = {
  ref: string | null;
  refType: string | null;
  mention: boolean;
  dm: boolean;
  reviewRequested: boolean;
  assigned: boolean;
  blocking: number | null;
  rsvpNeeded: boolean;
};

/** Trusted item facts written by the agents outside the fences. */
function readFacts(meta: string): Facts {
  const ref = /^Reference:\s*(\S+)\s*\(([^)]+)\)\s*$/m.exec(meta);
  const sig = /^Signals:\s*(.+)$/m.exec(meta)?.[1] ?? '';
  const blocking = /\bblocking (\d+) people\b/.exec(sig)?.[1];
  return {
    ref: ref?.[1] ?? null,
    refType: ref?.[2] ?? null,
    mention: /\bmentions you\b/.test(sig),
    dm: /\bdirect message\b/.test(sig),
    reviewRequested: /\breview requested\b/.test(sig),
    assigned: /\bassigned to you\b/.test(sig),
    blocking: blocking ? Number(blocking) : null,
    rsvpNeeded: /\bRSVP needed\b/.test(sig),
  };
}

const WORD_NUM = '(\\d+|two|three|four|five|six)';
const BLOCKING_RE = new RegExp(
  `\\bblock(?:ing|s|ed)\\s+${WORD_NUM}\\s+(?:people|folks|teammates|teams?|engineers|devs)\\b|\\b${WORD_NUM}\\s+(?:teammates|people|folks|engineers|devs)\\s+(?:are|is)\\s+(?:waiting|blocked)\\b`,
  'i',
);

/** Facts from the signal lines, or from the text when the connector set none (demo data). */
function cuesFor(item: ParsedItem & { kind: string }, facts: Facts): Facts {
  const text = `${item.subject}\n${item.body}`;
  const b = BLOCKING_RE.exec(text);
  const tracked = item.kind === 'ticket' || item.kind === 'code';
  return {
    ...facts,
    mention: facts.mention || /\b(?:mentioned you|you were mentioned)\b/i.test(text),
    reviewRequested:
      facts.reviewRequested ||
      (tracked &&
        /\b(?:requested (?:your|a) review|review requested|requested you to review)\b/i.test(text)),
    assigned:
      facts.assigned ||
      (tracked && /\bassigned (?:(?:this|it) )?to you\b|\bassigned you\b/i.test(text)),
    blocking: facts.blocking ?? (b ? wordNum((b[1] ?? b[2])!) : null),
    rsvpNeeded:
      facts.rsvpNeeded ||
      (item.kind === 'event' &&
        /\b(?:rsvp|please respond|awaiting your response|accept or decline)\b/i.test(text)),
  };
}

/** Issue/PR reference: the trusted Reference line, else a key or `repo#n` in the subject. */
function refFor(item: ParsedItem, facts: Facts): string | null {
  if (facts.ref) return facts.ref;
  const m =
    /\b([A-Z][A-Z0-9_]+-\d+)\b/.exec(item.subject) ?? /\b([\w.-]+#\d+)\b/.exec(item.subject);
  return m?.[1] ?? null;
}

const REPLYABLE = new Set(['email', 'chat']);

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

function fakeTriage(fences: Fence[], ref: string | null, facts: Facts) {
  const item = itemFence(fences);
  const cues = cuesFor(item, facts);
  const who = firstName(item.fromName, item.fromAddress) ?? 'Someone';
  const requests = requestSentences(item.body);
  const kind = item.kind;
  const tracked = kind === 'ticket' || kind === 'code';
  const itemRef = refFor(item, facts);

  let bucket: 'needs_you' | 'fyi' | 'ignore' = 'fyi';
  let reason = 'informational';
  if (cues.reviewRequested) {
    bucket = 'needs_you';
    reason = 'your review was requested';
  } else if (cues.assigned) {
    bucket = 'needs_you';
    reason = 'assigned to you';
  } else if (cues.rsvpNeeded) {
    bucket = 'needs_you';
    reason = 'the invite needs an answer';
  } else if (cues.mention && !isNoise(item)) {
    bucket = 'needs_you';
    reason = 'you were mentioned';
  } else if (isNoise(item)) {
    bucket = 'ignore';
    reason = 'automated or promotional';
  } else if (kind === 'event') {
    reason = 'calendar update';
  } else if (requests.length > 0 && (kind !== 'chat' || cues.dm || /\byou\b/i.test(item.body))) {
    bucket = 'needs_you';
    reason = 'contains a direct request';
  }

  // Learn from feedback: a sender whose tasks were rejected more often than confirmed
  // no longer lands in needs_you (trusted signals still do).
  if (bucket === 'needs_you' && reason === 'contains a direct request') {
    const sender = (item.fromAddress ?? item.fromName ?? '').toLowerCase();
    const fb = readFeedback(fences).filter((f) => (f.from ?? '').toLowerCase() === sender);
    const rejected = fb.filter((f) => f.verdict === 'rejected').length;
    const confirmed = fb.filter((f) => f.verdict === 'confirmed').length;
    if (sender && rejected > confirmed) {
      bucket = 'fyi';
      reason = 'similar requests from this sender were marked "Not a task"';
    }
  }

  const reply = bucket === 'needs_you' && REPLYABLE.has(kind) && expectsReply(item.body);
  const title = stripSubject(item.subject);
  const firstLine = item.body.split('\n')[0]!.slice(0, 100);
  let summary: string;
  if (bucket === 'needs_you' && tracked && (cues.reviewRequested || cues.assigned)) {
    const what = itemRef ? `${itemRef}` : 'this';
    summary = cues.reviewRequested
      ? `${who} requested your review on ${what}.`
      : `Assigned to you.${cues.blocking ? ` ${capitalize(numWord(cues.blocking))} teammates are waiting on it.` : ''}`;
  } else if (bucket === 'needs_you' && kind === 'event') {
    summary = `${who} invited you to ${title || 'an event'}. RSVP needed.`;
  } else if (bucket === 'needs_you' && requests.length > 0) {
    const first = requests[0]!;
    const action = lowerFirst(actionPhrase(first) || title);
    const due = dueFor(first, item.body, ref);
    summary = `${who} asked you to ${action}${due ? ` ${due.phrase}` : ''}.`;
  } else if (bucket === 'needs_you' && kind === 'chat') {
    const q = sentences(item.body).find((x) => x.endsWith('?'));
    summary = q ? `${who} asked: ${q}` : `${who} mentioned you: ${firstLine}`;
  } else if (tracked || kind === 'chat' || kind === 'note' || kind === 'file') {
    summary = firstLine || title;
  } else {
    summary = title || firstLine;
  }

  let statusLabel: string | null = null;
  if (bucket === 'needs_you') {
    statusLabel = cues.blocking
      ? `Blocking ${cues.blocking} people`
      : cues.reviewRequested
        ? 'Review requested'
        : cues.assigned
          ? 'Assigned to you'
          : cues.rsvpNeeded
            ? 'RSVP needed'
            : reply
              ? 'Needs reply'
              : cues.mention
                ? 'Mentioned you'
                : 'Needs you';
  } else if (bucket === 'fyi') statusLabel = 'FYI';

  return { bucket, summary: summary.slice(0, 200), statusLabel, expectsReply: reply, reason };
}

function numWord(n: number): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);
}

function wordNum(s: string): number {
  const w: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };
  return w[s.toLowerCase()] ?? Number(s);
}

function projectOf(item: ParsedItem): string | null {
  const tag = /\[([^\]]{2,30})\]/.exec(item.subject)?.[1];
  if (tag) return tag.trim();
  const q = /\b(Q[1-4])\b/.exec(`${item.subject} ${item.body}`)?.[1];
  return q ?? null;
}

function fakeExtract(fences: Fence[], ref: string | null, promises: boolean, facts: Facts) {
  const item = itemFence(fences);
  const who = firstName(item.fromName, item.fromAddress);
  const project = projectOf(item);
  if (!promises) {
    const cues = cuesFor(item, facts);
    const itemRef = refFor(item, facts);
    const title = stripSubject(item.subject);
    let special: string | null = null;
    if ((item.kind === 'ticket' || item.kind === 'code') && itemRef) {
      if (cues.reviewRequested) special = `Review ${itemRef}`;
      else if (cues.assigned) {
        const rest = title.replace(itemRef, '').replace(/^[\s:·-]+/, '');
        special = cues.blocking
          ? `Unblock ${itemRef}`
          : rest
            ? `${itemRef}: ${rest}`
            : `Work on ${itemRef}`;
      }
    } else if (item.kind === 'event' && cues.rsvpNeeded && title) {
      special = `RSVP to ${title}`;
    }
    if (special) {
      return {
        tasks: [
          { title: special.slice(0, 120), due: null, dueTime: null, project, confidence: 0.9 },
        ],
      };
    }
  }
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
      line = `Yes, I'll ${flipPronouns(lowerFirst(action))}${due ? ` ${due.phrase}` : ''}.`;
      if (due) {
        topic = `${stripSubject(item.subject) || capitalize(objectOf(action))} timeline`;
      }
    }
  }
  if (item.kind === 'chat') {
    return { body: line.replace(/^Thanks for the note\. /, 'Thanks! '), topic: topic.slice(0, 60) };
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

/** The request is in the sender's voice ("send me my notes"); the reply is in ours. */
function flipPronouns(s: string): string {
  const map: Record<string, string> = {
    me: 'you',
    my: 'your',
    us: 'you',
    our: 'your',
    mine: 'yours',
  };
  return s.replace(/\b(me|my|us|our|mine)\b/gi, (w) => map[w.toLowerCase()] ?? w);
}
