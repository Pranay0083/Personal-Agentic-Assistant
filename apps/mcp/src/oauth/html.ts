import { randomBytes } from 'node:crypto';
import type { Response } from 'express';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Hub design tokens (design/README.md). */
const STYLE = `
:root{--bg:#F6F4EF;--card:#FFFFFF;--border:#E4E0D6;--ink:#1B1A17;--muted:#5E5A52;--teal:#1F6F6B;--tint:#E3EFEC;--tint-ink:#174F4C;--amber-tint:#F7EBDD;--amber-ink:#7A3E0B}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans',system-ui,sans-serif;font-size:16px;line-height:1.45}
main{max-width:420px;margin:0 auto;padding:48px 16px}
h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:34px;line-height:1.1;margin:0 0 12px}
p{margin:0 0 16px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;margin:20px 0}
.card p{margin:8px 0 0}
.tag{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.strong{font-weight:600;color:var(--ink);word-break:break-word}
label{display:block;font-weight:500;margin:0 0 8px}
input[type=email]{width:100%;min-height:48px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;font:inherit;background:#fff;color:var(--ink)}
input[type=email]:focus{outline:2px solid var(--teal);outline-offset:1px}
button{width:100%;min-height:48px;margin-top:16px;border:0;border-radius:12px;background:var(--teal);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.status{display:flex;gap:12px;align-items:center;padding:14px 16px;border-radius:12px;background:var(--tint);color:var(--tint-ink);margin:12px 0}
.status.warn{background:var(--amber-tint);color:var(--amber-ink)}
.dot{width:10px;height:10px;border-radius:50%;background:currentColor;flex:none;animation:pulse 1.4s ease-in-out infinite}
.warn .dot{animation:none}
@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
small{color:var(--muted)}
`;

const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;500;600&family=Instrument+Serif&display=swap';

/** Sends a self-contained HTML page with a strict, nonce-based CSP. */
export function sendPage(
  res: Response,
  title: string,
  body: string,
  script?: string,
  status = 200,
) {
  const nonce = randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
      'font-src https://fonts.gstatic.com',
      `script-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<link nonce="${nonce}" rel="stylesheet" href="${FONTS}">` +
    `<style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main>` +
    (script ? `<script nonce="${nonce}">${script}</script>` : '') +
    `</body></html>`;
  res.status(status).type('html').send(html);
}
