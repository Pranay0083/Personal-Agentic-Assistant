/**
 * Jira rich text (Atlassian Document Format) and Confluence storage format (XHTML with
 * `ac:`/`ri:` macros) to plain text. The output is untrusted content: callers store it
 * encrypted and fence it before a model sees it.
 */

export type AdfNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'panel',
  'rule',
  'mediaSingle',
  'mediaGroup',
  'expand',
  'nestedExpand',
  'decisionList',
  'taskList',
  'blockCard',
  'embedCard',
]);

function attr(n: AdfNode, k: string): string | undefined {
  const v = n.attrs?.[k];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

function inline(n: AdfNode): string {
  switch (n.type) {
    case 'text': {
      const link = n.marks?.find((m) => m.type === 'link')?.attrs?.href;
      const t = n.text ?? '';
      return typeof link === 'string' && link !== t ? `${t} (${link})` : t;
    }
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const t = attr(n, 'text') ?? '';
      return t.startsWith('@') ? t : `@${t || 'someone'}`;
    }
    case 'emoji':
      return attr(n, 'text') ?? attr(n, 'shortName') ?? '';
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return attr(n, 'url') ?? '';
    case 'status':
      return `[${attr(n, 'text') ?? ''}]`;
    case 'date': {
      const ts = Number(attr(n, 'timestamp'));
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    case 'media':
    case 'mediaInline':
      return '[attachment]';
    default:
      return (n.content ?? []).map(inline).join('');
  }
}

function block(n: AdfNode, indent: string): string {
  switch (n.type) {
    case 'doc':
      return blocks(n.content, indent);
    case 'bulletList':
    case 'orderedList': {
      const start = Number(n.attrs?.order ?? 1) || 1;
      return (n.content ?? [])
        .map((li, i) => {
          const bullet = n.type === 'orderedList' ? `${start + i}. ` : '- ';
          const body = blocks(li.content, indent + '  ', '\n').trim();
          return `${indent}${bullet}${body}`;
        })
        .join('\n');
    }
    case 'taskList':
    case 'decisionList':
      return (n.content ?? [])
        .map((item) => {
          const done = item.attrs?.state === 'DONE' || item.attrs?.state === 'DECIDED';
          return `${indent}[${done ? 'x' : ' '}] ${inline(item).trim()}`;
        })
        .join('\n');
    case 'table':
      return (n.content ?? [])
        .map((row) =>
          (row.content ?? []).map((cell) => blocks(cell.content, '').trim()).join(' | '),
        )
        .join('\n');
    case 'codeBlock':
      return (n.content ?? []).map((c) => c.text ?? '').join('');
    case 'rule':
      return '---';
    case 'blockquote':
    case 'panel':
    case 'expand':
    case 'nestedExpand': {
      const title = attr(n, 'title');
      const inner = blocks(n.content, indent);
      return title ? `${title}\n${inner}` : inner;
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return '[attachment]';
    case 'paragraph':
    case 'heading':
      return inline(n);
    default:
      return n.content?.some(isBlock) ? blocks(n.content, indent) : inline(n);
  }
}

function isBlock(n: AdfNode): boolean {
  return BLOCKS.has(n.type) || /List$|^table$|^doc$/.test(n.type);
}

function blocks(content: AdfNode[] | undefined, indent: string, sep = '\n\n'): string {
  return (content ?? [])
    .map((c) => block(c, indent))
    .filter((s) => s.trim() !== '')
    .join(sep);
}

/** Whether an ADF document has a `mention` node for this account id (structure, not text). */
export function adfMentions(doc: unknown, accountId: string | null | undefined): boolean {
  if (!accountId || !doc || typeof doc !== 'object') return false;
  const n = doc as AdfNode;
  if (n.type === 'mention' && n.attrs?.id === accountId) return true;
  return Array.isArray(n.content) && n.content.some((c) => adfMentions(c, accountId));
}

/**
 * Storage-format markup with the parts that are literal text, not markup, removed: CDATA
 * sections, the bodies of `ac:plain-text-body` (code and noformat macros) and XML comments.
 * A `<ri:user …>` typed into a code block is text, and must not count as a mention.
 */
function storageMarkupOnly(storage: string): string {
  // CDATA first: it cannot contain `]]>`, but it can contain a fake `</ac:plain-text-body>`.
  return storage
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<ac:plain-text-body\b[^>]*>[\s\S]*?(?:<\/ac:plain-text-body\s*>|$)/gi, '');
}

/** Whether Confluence storage format has a user link (`<ri:user ri:account-id>`) to this account. */
export function storageMentions(
  storage: string | null | undefined,
  accountId: string | null | undefined,
): boolean {
  if (!storage || !accountId) return false;
  const markup = storageMarkupOnly(storage);
  for (const m of markup.matchAll(/<ri:user\b[^>]*\bri:account-id="([^"]+)"/gi)) {
    if (m[1] === accountId) return true;
  }
  return false;
}

/** ADF document (or a v2 plain-string description) to text. */
export function adfToText(doc: unknown): string {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc.trim();
  if (typeof doc !== 'object' || typeof (doc as AdfNode).type !== 'string') return '';
  return tidy(block(doc as AdfNode, ''));
}

/** Plain text to a minimal ADF document: one paragraph per blank-line block, hard breaks inside. */
export function textToAdf(text: string): AdfNode {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i): AdfNode[] => {
        const parts: AdfNode[] = i > 0 ? [{ type: 'hardBreak' }] : [];
        if (line) parts.push({ type: 'text', text: line });
        return parts;
      }),
    })),
  } as AdfNode;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Confluence storage format to text. Keeps macro bodies, user and page links; drops markup. */
export function storageToText(storage: string | null | undefined): string {
  if (!storage) return '';
  let s = storage;
  // CDATA (code macro bodies) is literal text.
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  // Macro parameters are configuration, not content.
  s = s.replace(/<ac:parameter\b[\s\S]*?<\/ac:parameter>/gi, '');
  // Mentions and page links.
  s = s.replace(/<ri:user\b[^>]*\/?>/gi, ' @user ');
  s = s.replace(
    /<ri:page\b[^>]*ri:content-title="([^"]*)"[^>]*\/?>/gi,
    (_m, t: string) => ` ${t} `,
  );
  s = s.replace(/<ac:link-body>([\s\S]*?)<\/ac:link-body>/gi, (_m, t: string) => t);
  s = s.replace(/<ac:image\b[\s\S]*?(<\/ac:image>|\/>)/gi, ' [image] ');
  s = s.replace(/<ac:emoticon\b[^>]*ac:emoji-fallback="([^"]*)"[^>]*\/?>/gi, (_m, t: string) => t);
  s = s.replace(/<ac:task-status>complete<\/ac:task-status>/gi, '[x] ');
  s = s.replace(/<ac:task-status>incomplete<\/ac:task-status>/gi, '[ ] ');
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
    const text = t.replace(/<[^>]+>/g, '').trim();
    return text && text !== href ? `${text} (${href})` : href;
  });
  // Structure.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(td|th)>/gi, ' | ');
  s = s.replace(/<hr\s*\/?>/gi, '\n---\n');
  s = s.replace(
    /<\/?(p|div|h[1-6]|tr|table|ul|ol|blockquote|pre|ac:task|ac:layout-cell)\b[^>]*>/gi,
    '\n',
  );
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((l) =>
      l
        .replace(/\s*\|\s*$/, '')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .join('\n');
  return tidy(s);
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Caps text at `max` characters on a word boundary, with an ellipsis. */
export function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.8 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
