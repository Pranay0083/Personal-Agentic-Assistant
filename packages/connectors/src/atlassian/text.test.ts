import { describe, expect, it } from 'vitest';
import { fixture } from '../lib/fake';
import type { ConfluenceSearchPage, JiraSearchPage } from './api-types';
import { adfToText, cap, storageMentions, storageToText, textToAdf } from './text';

describe('adfToText', () => {
  const page = fixture<JiraSearchPage>(import.meta.url, 'search-page-1.json');
  const issue = page.issues[1]!;

  it('flattens paragraphs, marks and ordered lists', () => {
    expect(adfToText(issue.fields.description)).toBe(
      'Applying the same promo code twice returns a 500 from the cart service.\n\n1. Add item to cart\n2. Apply SAVE10 twice',
    );
  });

  it('keeps mentions, hard breaks and link targets', () => {
    const c = issue.fields.comment!.comments[1]!;
    expect(adfToText(c.body)).toBe(
      '@Alex Kim any update? QA is waiting.\nSee the runbook (https://acme.atlassian.net/wiki/x/QQAB)',
    );
  });

  it('handles nested lists, tables, code, tasks and odd input', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
                },
              ],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { state: 'DONE' },
              content: [{ type: 'text', text: 'ship' }],
            },
          ],
        },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
      ],
    };
    expect(adfToText(doc)).toBe(
      'Plan\n\n- one\n  - nested\n\nA | B\n\nx = 1\n\n[x] ship\n\n[attachment]',
    );
    expect(adfToText(null)).toBe('');
    expect(adfToText('plain v2 text ')).toBe('plain v2 text');
    expect(adfToText({ nope: true })).toBe('');
  });

  it('textToAdf builds paragraphs with hard breaks and round-trips', () => {
    const adf = textToAdf('Fix merged in #219.\nReady for QA.\n\nThanks');
    expect(adf.content).toHaveLength(2);
    expect(adf.content![0]!.content!.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text']);
    expect(adfToText(adf)).toBe('Fix merged in #219.\nReady for QA.\n\nThanks');
  });
});

describe('storageToText', () => {
  it('converts Confluence storage format, keeping macro bodies and links', () => {
    const page = fixture<ConfluenceSearchPage>(import.meta.url, 'confluence-search.json');
    const text = storageToText(page.results[0]!.content!.body!.storage!.value);
    expect(text).toBe(
      [
        'Goals',
        '',
        'Ship checkout v2 by Oct 15 & keep p95 < 300ms.',
        '',
        '- Promo codes',
        '- Saved cards',
        '',
        'Owner | Area',
        '',
        '@user | Payments',
        '',
        'pnpm deploy --env <prod>',
        'See Release process and status (https://status.acme.example).',
      ].join('\n'),
    );
  });

  it('drops scripts and decodes numeric entities', () => {
    expect(storageToText('<p>a&#39;b &#x2014; c</p><script>alert(1)</script>')).toBe("a'b — c");
    expect(storageToText(null)).toBe('');
  });

  it('caps long text on a word boundary', () => {
    expect(cap('hello brave new world', 13)).toBe('hello brave…');
    expect(cap('short', 10)).toBe('short');
  });
});

describe('storageMentions', () => {
  const ME = '5b10ac8d82e05b22cc7d4ef5';
  const link = `<ac:link><ri:user ri:account-id="${ME}" /></ac:link>`;

  it('finds a real user link', () => {
    expect(storageMentions(`<p>Hi ${link}, please review</p>`, ME)).toBe(true);
    expect(storageMentions(`<p>Hi ${link}</p>`, 'someone-else')).toBe(false);
    expect(storageMentions(null, ME)).toBe(false);
  });

  it('ignores a user link typed into a code macro (CDATA / plain-text-body)', () => {
    const code =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">xml</ac:parameter>' +
      `<ac:plain-text-body><![CDATA[${link}]]></ac:plain-text-body></ac:structured-macro>`;
    expect(storageMentions(`<p>Snippet:</p>${code}`, ME)).toBe(false);
    // A fake closing tag inside the CDATA does not end the code block early.
    const tricky =
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x</ac:plain-text-body>' +
      `${link}]]></ac:plain-text-body></ac:structured-macro>`;
    expect(storageMentions(tricky, ME)).toBe(false);
    // Non-CDATA plain-text body, unterminated CDATA and comments are text too.
    expect(storageMentions(`<ac:plain-text-body>${link}</ac:plain-text-body>`, ME)).toBe(false);
    expect(storageMentions(`<p>a</p><![CDATA[${link}`, ME)).toBe(false);
    expect(storageMentions(`<!-- ${link} -->`, ME)).toBe(false);
    // A real mention next to a code block still counts.
    expect(storageMentions(`${code}<p>${link}</p>`, ME)).toBe(true);
  });
});
