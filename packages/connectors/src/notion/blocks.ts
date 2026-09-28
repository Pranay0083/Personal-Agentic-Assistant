import type { NotionBlock, NotionClient, RichText } from './client';

export type FlattenLimits = {
  /** Nesting levels below the page to descend into (the page's own children are depth 0). */
  maxDepth: number;
  /** Characters of output; the walk stops once reached. */
  maxChars: number;
  /** HTTP requests one page may spend on block children. */
  maxRequests: number;
};

export const DEFAULT_FLATTEN_LIMITS: FlattenLimits = {
  maxDepth: 3,
  maxChars: 20_000,
  maxRequests: 25,
};

export function richText(rt: unknown): string {
  if (!Array.isArray(rt)) return '';
  return (rt as RichText[]).map((t) => t?.plain_text ?? '').join('');
}

/** Ids of users @-mentioned in a rich-text array (structured mention objects, not text). */
export function userMentions(rt: unknown): string[] {
  if (!Array.isArray(rt)) return [];
  return (rt as RichText[])
    .filter((t) => t?.type === 'mention' && t.mention?.type === 'user' && !!t.mention.user?.id)
    .map((t) => t.mention!.user!.id!);
}

/** User mentions anywhere in a block's rich text, captions or table cells. */
export function blockMentions(b: NotionBlock): string[] {
  const data = (b[b.type] ?? {}) as Record<string, unknown>;
  const cells = Array.isArray(data.cells) ? (data.cells as unknown[]) : [];
  return [
    ...userMentions(data.rich_text),
    ...userMentions(data.caption),
    ...cells.flatMap((c) => userMentions(c)),
  ];
}

type Rich = { rich_text?: RichText[]; checked?: boolean; language?: string };

/** One block as a line of plain text (without indentation), or null when it has no text. */
export function blockLine(b: NotionBlock, ordinal = 1): string | null {
  const data = (b[b.type] ?? {}) as Rich & Record<string, unknown>;
  const text = richText(data.rich_text);
  switch (b.type) {
    case 'paragraph':
    case 'toggle':
    case 'template':
      return text || null;
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
    case 'heading_4':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `${ordinal}. ${text}`;
    case 'to_do':
      return `[${data.checked ? 'x' : ' '}] ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'callout':
      return text ? `! ${text}` : null;
    case 'code':
      return text ? `\`\`\`\n${text}\n\`\`\`` : null;
    case 'equation':
      return typeof data.expression === 'string' ? data.expression : null;
    case 'child_page':
    case 'child_database':
      return typeof data.title === 'string' && data.title ? `[${data.title}]` : null;
    case 'table_row': {
      const cells = Array.isArray(data.cells) ? (data.cells as unknown[]) : [];
      return cells.map((c) => richText(c)).join(' | ') || null;
    }
    case 'divider':
      return '---';
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const caption = richText(data.caption);
      return caption || null;
    }
    default:
      // Media, files, breadcrumbs, synced block wrappers, columns: no text of their own.
      return text || null;
  }
}

/** Children of these are rendered; child pages are separate search results, not descended. */
const NO_DESCEND = new Set(['child_page', 'child_database']);

/**
 * Flattens a page's blocks to plain text: recursive children with two-space indentation,
 * capped by depth, size and request budget. Returns `truncated` when a cap was hit.
 */
export async function flattenPage(
  client: Pick<NotionClient, 'blockChildren'>,
  pageId: string,
  limits: FlattenLimits = DEFAULT_FLATTEN_LIMITS,
): Promise<{ text: string; truncated: boolean; mentions: string[] }> {
  const lines: string[] = [];
  const mentions = new Set<string>();
  let chars = 0;
  let requests = 0;
  let truncated = false;

  const full = () => chars >= limits.maxChars;

  async function walk(blockId: string, depth: number): Promise<void> {
    let cursor: string | null = null;
    let ordinal = 0;
    do {
      if (full() || requests >= limits.maxRequests) {
        truncated = true;
        return;
      }
      requests++;
      const res = await client.blockChildren(blockId, cursor);
      for (const b of res.results) {
        if (full()) {
          truncated = true;
          return;
        }
        if (b.in_trash || b.archived) continue;
        for (const id of blockMentions(b)) mentions.add(id);
        ordinal = b.type === 'numbered_list_item' ? ordinal + 1 : 0;
        const line = blockLine(b, ordinal || 1);
        if (line !== null) {
          const indented = '  '.repeat(depth) + line.replace(/\n/g, `\n${'  '.repeat(depth)}`);
          lines.push(indented);
          chars += indented.length + 1;
        }
        if (b.has_children && !NO_DESCEND.has(b.type)) {
          if (depth + 1 > limits.maxDepth) truncated = true;
          else await walk(b.id, depth + 1);
        }
      }
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
  }

  await walk(pageId, 0);
  let text = lines.join('\n');
  if (text.length > limits.maxChars) {
    text = text.slice(0, limits.maxChars);
    truncated = true;
  }
  return { text, truncated, mentions: [...mentions] };
}
