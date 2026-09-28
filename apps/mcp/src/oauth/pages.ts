import type { Response } from 'express';
import { escapeHtml, sendPage } from './html';

export type ConsentFields = Record<string, string | undefined>;

function hidden(fields: ConsentFields): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v!)}">`)
    .join('');
}

function clientCard(clientName: string, redirectHost: string) {
  return (
    `<div class="card"><div class="tag">Connection request</div>` +
    `<p><span class="strong">${escapeHtml(clientName)}</span> wants to read your Hub context ` +
    `and propose actions for you to approve. You'll be sent back to ` +
    `<span class="strong">${escapeHtml(redirectHost)}</span>.</p></div>`
  );
}

export function consentPage(
  res: Response,
  opts: {
    action: string;
    clientName: string;
    redirectHost: string;
    fields: ConsentFields;
    error?: string;
  },
) {
  sendPage(
    res,
    'Connect to Hub',
    `<div class="tag">Hub</div><h1>Connect an agent</h1>` +
      clientCard(opts.clientName, opts.redirectHost) +
      `<form method="post" action="${escapeHtml(opts.action)}">` +
      hidden(opts.fields) +
      `<label for="email">Your Hub email</label>` +
      `<input id="email" name="hub_email" type="email" autocomplete="email" required maxlength="254">` +
      (opts.error ? `<div class="status warn">${escapeHtml(opts.error)}</div>` : '') +
      `<button type="submit">Ask on my phone</button></form>` +
      `<p style="margin-top:16px"><small>You approve the connection in the Hub app. Nothing is ` +
      `shared until you do, and you can revoke it any time from Permissions.</small></p>`,
    undefined,
    opts.error ? 429 : 200,
  );
}

const POLL_SCRIPT = `
(function(){
  var cfg=JSON.parse(document.getElementById('cfg').textContent);
  var el=document.getElementById('status'),txt=document.getElementById('status-text');
  function show(msg){txt.textContent=msg;el.className='status warn';}
  function poll(){
    fetch(cfg.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:cfg.t}),credentials:'omit'})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.status==='allowed'&&d.redirect){txt.textContent='Approved. Returning you to your agent…';window.location.replace(d.redirect);return;}
        if(d.status==='denied'){show('The request was denied on your phone. You can close this tab.');return;}
        if(d.status==='expired'){show('The request expired. Start the connection again from your agent.');return;}
        if(d.status==='used'){show('This approval was already used. Start again from your agent if needed.');return;}
        setTimeout(poll,2000);
      })
      .catch(function(){setTimeout(poll,4000);});
  }
  poll();
})();`;

export function waitingPage(
  res: Response,
  opts: { clientName: string; redirectHost: string; statusUrl: string; pollToken: string },
) {
  // JSON in a non-executed script tag; `<` escaped so it cannot close the tag.
  const cfg = JSON.stringify({ url: opts.statusUrl, t: opts.pollToken }).replace(/</g, '\\u003c');
  sendPage(
    res,
    'Approve on your phone',
    `<div class="tag">Hub</div><h1>Check your phone</h1>` +
      clientCard(opts.clientName, opts.redirectHost) +
      `<p>If that email has a Hub account, the app just got a request. Open Hub, go to ` +
      `Approvals and allow <span class="strong">${escapeHtml(opts.clientName)}</span>. ` +
      `Keep this tab open.</p>` +
      `<div id="status" class="status" role="status" aria-live="polite"><span class="dot"></span>` +
      `<span id="status-text">Waiting for approval…</span></div>` +
      `<script type="application/json" id="cfg">${cfg}</script>`,
    POLL_SCRIPT,
  );
}
