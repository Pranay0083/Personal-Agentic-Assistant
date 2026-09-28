import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { GmailMessage } from './client';
import { fixture } from './fixtures/index';

/**
 * Fixture-backed fake mailboxes for GMAIL_FAKE=1 (local demo without Google) and tests.
 * The file store lives at `<repo>/.dev/fake-gmail.json` so the gateway's fake:email
 * script, the api and the workers all see the same mailboxes.
 */

export type FakeHistoryRecord = {
  id: string;
  messages: { id: string; threadId: string }[];
  messagesAdded: { message: { id: string; threadId: string; labelIds: string[] } }[];
};

export type FakeMailbox = {
  email: string;
  displayName: string;
  nickname: string;
  historyId: number;
  /** history.list with a startHistoryId below this returns 404 (history expired). */
  minHistoryId: number;
  messages: GmailMessage[];
  history: FakeHistoryRecord[];
  watch: { expiration: number; labelIds: string[] } | null;
  /** Simulates a revoked grant: every call fails with invalid_grant. */
  revoked: boolean;
};

export type FakeState = {
  version: 1;
  connectCounter: number;
  mailboxes: Record<string, FakeMailbox>;
};

type SeedFile = {
  mailboxes: {
    email: string;
    displayName: string;
    nickname: string;
    historyId: string;
    messages: string[];
  }[];
};

/** Builds the initial state from the recorded fixtures, with dates shifted to "recent". */
export function seedFakeState(now = Date.now()): FakeState {
  const seed = fixture<SeedFile>('fake-mailboxes.json');
  const mailboxes: Record<string, FakeMailbox> = {};
  for (const mb of seed.mailboxes) {
    const historyId = Number(mb.historyId);
    const messages = mb.messages.map((file, i) => {
      const m = fixture<GmailMessage>(file);
      return {
        ...m,
        internalDate: String(now - (i + 1) * 2 * 3600_000),
        historyId: String(historyId),
      };
    });
    mailboxes[mb.email] = {
      email: mb.email,
      displayName: mb.displayName,
      nickname: mb.nickname,
      historyId,
      minHistoryId: historyId,
      messages,
      history: [],
      watch: null,
      revoked: false,
    };
  }
  return { version: 1, connectCounter: 0, mailboxes };
}

interface Persistence {
  read(): FakeState | null;
  write(state: FakeState): void;
  withLock<T>(fn: () => T): T;
}

function memoryPersistence(initial: FakeState | null): Persistence {
  let state = initial ? structuredClone(initial) : null;
  return {
    read: () => (state ? structuredClone(state) : null),
    write: (s) => {
      state = structuredClone(s);
    },
    withLock: (fn) => fn(),
  };
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function filePersistence(file: string): Persistence {
  const lock = `${file}.lock`;
  return {
    read() {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as FakeState;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    write(state) {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 1));
      renameSync(tmp, file);
    },
    withLock(fn) {
      mkdirSync(path.dirname(file), { recursive: true });
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          mkdirSync(lock);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          try {
            if (Date.now() - statSync(lock).mtimeMs > 10_000)
              rmSync(lock, { recursive: true, force: true });
          } catch {
            // lock vanished between checks
          }
          if (Date.now() > deadline)
            throw new Error('fake gmail store: lock timeout', { cause: e });
          sleepSync(10);
        }
      }
      try {
        return fn();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    },
  };
}

export type NewFakeMessage = {
  from: string;
  fromName?: string;
  to?: string;
  subject: string;
  body: string;
  html?: string;
  labelIds?: string[];
  threadId?: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  date?: Date;
};

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
export const fakeId = () => randomBytes(8).toString('hex');

export class FakeGmailStore {
  private constructor(private readonly p: Persistence) {}

  static memory(initial: FakeState = seedFakeState()) {
    return new FakeGmailStore(memoryPersistence(initial));
  }

  static file(file: string) {
    return new FakeGmailStore(filePersistence(file));
  }

  /** Current state (seeded from fixtures on first use). */
  read(): FakeState {
    return this.p.read() ?? this.update((s) => s);
  }

  update<T>(fn: (s: FakeState) => T): T {
    return this.p.withLock(() => {
      const s = this.p.read() ?? seedFakeState();
      const out = fn(s);
      this.p.write(s);
      return out;
    });
  }

  mailbox(email: string): FakeMailbox | undefined {
    return this.read().mailboxes[email.toLowerCase()];
  }

  emails(): string[] {
    return Object.keys(this.read().mailboxes);
  }

  /** The mailbox a fake OAuth consent "signs in" as: by login hint, else round-robin. */
  pickForConnect(loginHint?: string): string {
    return this.update((s) => {
      const emails = Object.keys(s.mailboxes);
      const hint = loginHint?.toLowerCase();
      if (hint && s.mailboxes[hint]) return hint;
      const pick = emails[s.connectCounter % emails.length]!;
      s.connectCounter += 1;
      return pick;
    });
  }

  setRevoked(email: string, revoked: boolean) {
    this.update((s) => {
      const mb = s.mailboxes[email.toLowerCase()];
      if (mb) mb.revoked = revoked;
    });
  }

  /** Makes every existing history id "too old" (history.list returns 404 for them). */
  expireHistory(email: string) {
    this.update((s) => {
      const mb = s.mailboxes[email.toLowerCase()];
      if (mb) {
        mb.historyId += 1;
        mb.minHistoryId = mb.historyId;
      }
    });
  }

  /** Delivers a message and records a messageAdded history entry. */
  appendMessage(email: string, msg: NewFakeMessage): { message: GmailMessage; historyId: string } {
    return this.update((s) => {
      const mb = s.mailboxes[email.toLowerCase()];
      if (!mb) throw new Error(`fake gmail: no mailbox ${email}`);
      const id = fakeId();
      const threadId = msg.threadId ?? id;
      const labelIds = msg.labelIds ?? ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'];
      const date = msg.date ?? new Date();
      const from = msg.fromName ? `${msg.fromName} <${msg.from}>` : msg.from;
      const headers = [
        { name: 'MIME-Version', value: '1.0' },
        { name: 'Date', value: date.toUTCString() },
        { name: 'Message-ID', value: msg.messageIdHeader ?? `<${id}@fake.gmail.example>` },
        ...(msg.inReplyTo ? [{ name: 'In-Reply-To', value: msg.inReplyTo }] : []),
        { name: 'Subject', value: msg.subject },
        { name: 'From', value: from },
        { name: 'To', value: msg.to ?? mb.email },
      ];
      const plainPart = {
        partId: '0',
        mimeType: 'text/plain',
        filename: '',
        headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
        body: { size: Buffer.byteLength(msg.body), data: b64u(msg.body) },
      };
      const payload = msg.html
        ? {
            partId: '',
            mimeType: 'multipart/alternative',
            filename: '',
            headers: [
              ...headers,
              { name: 'Content-Type', value: 'multipart/alternative; boundary="fake"' },
            ],
            body: { size: 0 },
            parts: [
              plainPart,
              {
                partId: '1',
                mimeType: 'text/html',
                filename: '',
                headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
                body: { size: Buffer.byteLength(msg.html), data: b64u(msg.html) },
              },
            ],
          }
        : {
            ...plainPart,
            partId: '',
            headers: [...headers, { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
          };
      mb.historyId += 1;
      const message: GmailMessage = {
        id,
        threadId,
        labelIds,
        snippet: msg.body.replace(/\s+/g, ' ').trim().slice(0, 140),
        sizeEstimate: Buffer.byteLength(msg.body) + 800,
        historyId: String(mb.historyId),
        internalDate: String(date.getTime()),
        payload,
      };
      mb.messages.push(message);
      mb.history.push({
        id: String(mb.historyId),
        messages: [{ id, threadId }],
        messagesAdded: [{ message: { id, threadId, labelIds } }],
      });
      return { message, historyId: String(mb.historyId) };
    });
  }
}

/** Walks up from cwd to the pnpm workspace root. */
export function repoRoot(start = process.cwd()): string {
  for (let dir = start, i = 0; i < 8; i++, dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
  }
  return start;
}

export const DEFAULT_FAKE_STORE_PATH = () => path.join(repoRoot(), '.dev', 'fake-gmail.json');

let shared: FakeGmailStore | undefined;

/** The process-wide file store shared by all services in fake mode. */
export function defaultFakeStore(): FakeGmailStore {
  shared ??= FakeGmailStore.file(DEFAULT_FAKE_STORE_PATH());
  return shared;
}
