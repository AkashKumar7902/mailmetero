// @mailmetero/api — public web tool: a no-key, MailMeteor-style finder page at `/` plus the
// `GET /app/find` endpoint it calls. Both are PUBLIC (requiresAuth:false) — the paid `/v2/*` API
// stays key-gated. `/app/find` is per-IP rate-limited and runs the finder against an internal
// web-tool tenant (deps.webTenantId) with NO billing and NO API key ever exposed to the browser.
// Derivation-only: this never fetches LinkedIn — a pasted profile URL is parsed client-side for the
// name only.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FinderRequest } from '@mailmetero/pipeline';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { toFinderResult } from '../mapping/wire.ts';
import { ctxOf } from './support.ts';

const PUBLIC_PAGE: RouteConfig = {
  endpoint: 'openapi', requiresAuth: false, rateLimited: false,
  getIdempotent: false, postIdempotent: false, sandboxable: false,
};
const PUBLIC_FIND: RouteConfig = { ...PUBLIC_PAGE, endpoint: 'email_finder' };

// ── simple per-IP rate limiter (single free instance; in-memory is sufficient) ──
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const buckets = new Map<string, { count: number; resetAt: number }>();
function overLimit(ip: string, now: number): boolean {
  const b = buckets.get(ip);
  if (b === undefined || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  b.count += 1;
  return b.count > MAX_PER_WINDOW;
}

interface FindQuery { first_name?: string; last_name?: string; full_name?: string; domain?: string }

export function webRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/', { config: PUBLIC_PAGE }, async (_req, reply) => {
    return reply.header('content-type', 'text/html; charset=utf-8').send(PAGE_HTML);
  });

  app.get('/app/find', { config: PUBLIC_FIND }, async (request, reply) => {
    const ctx = ctxOf(request);
    if (overLimit(request.ip, Date.now())) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Too many requests — try again in a minute.' });
    }
    const q = (request.query as FindQuery) ?? {};
    const domainRaw = (q.domain ?? '').trim();
    if (domainRaw.length === 0) return reply.status(400).send({ error: 'domain_required', message: 'A company domain is required.' });

    const domainInput = deps.core.classifyDomainInput(domainRaw, deps.core.classificationTables);
    if (domainInput === null) return reply.status(400).send({ error: 'invalid_domain', message: `Couldn't read a domain from "${domainRaw}".` });

    const hasName = (q.first_name ?? '').trim() !== '' || (q.last_name ?? '').trim() !== '' || (q.full_name ?? '').trim() !== '';
    if (!hasName) return reply.status(400).send({ error: 'name_required', message: 'A name is required.' });

    const name = deps.core.normalizeName(
      {
        ...(q.first_name !== undefined ? { firstName: q.first_name } : {}),
        ...(q.last_name !== undefined ? { lastName: q.last_name } : {}),
        ...(q.full_name !== undefined ? { fullName: q.full_name } : {}),
      },
      deps.core.nicknameMap,
      { domain: domainInput.domain },
    );

    const hash = createHash('sha256')
      .update(`web:${domainInput.domain}:${name.normalized.firstName ?? ''}:${name.normalized.lastName ?? ''}`)
      .digest('hex');

    const req: FinderRequest = {
      tenantId: deps.webTenantId,
      requestId: ctx.requestId,
      name,
      domain: domainInput,
      cacheKey: { kind: 'find', hash },
    };

    const out = await deps.pipeline.find(req);
    if (out.kind === 'input_error') return reply.status(400).send({ error: out.code, message: out.details });
    if (out.kind === 'unavailable') return reply.status(503).send({ error: 'unavailable', message: 'The finder is temporarily unavailable.' });
    return reply.send({ data: toFinderResult(out.result) });
  });
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mailmetero — Email Finder</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9C%89%EF%B8%8F%3C/text%3E%3C/svg%3E">
<style>
  :root{--bg:#0b1020;--card:#151b2e;--ink:#e8ecf7;--muted:#93a0bd;--line:#26304b;--brand:#5b8cff;--brand2:#8a6cff;--good:#2fbf71;--warn:#e0a93b;--bad:#e05b5b}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);
    background:radial-gradient(1200px 600px at 50% -10%,#1a2540,#0b1020 60%),var(--bg);min-height:100vh}
  .wrap{max-width:640px;margin:0 auto;padding:56px 20px 80px}
  .logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:18px;letter-spacing:.2px}
  .logo .dot{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--brand),var(--brand2));display:grid;place-items:center;font-size:15px}
  h1{font-size:34px;line-height:1.15;margin:34px 0 8px;letter-spacing:-.5px}
  .sub{color:var(--muted);margin:0 0 28px;font-size:16px}
  .card{background:linear-gradient(180deg,#171e33,#131a2b);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 20px 50px rgba(0,0,0,.35)}
  label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px;font-weight:600}
  input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#0e1424;color:var(--ink);font-size:15px;outline:none}
  input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(91,140,255,.18)}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:10px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;
    background:linear-gradient(135deg,var(--brand),var(--brand2))}
  button:disabled{opacity:.6;cursor:not-allowed}
  .hint{font-size:12px;color:var(--muted);margin-top:6px}
  .result{margin-top:22px;display:none}
  .email{font-size:22px;font-weight:700;word-break:break-all}
  .badges{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
  .pill{font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;border:1px solid var(--line)}
  .meter{height:8px;border-radius:999px;background:#0e1424;overflow:hidden;margin:6px 0 4px}
  .meter>span{display:block;height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2))}
  .cand{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
  .cand summary{cursor:pointer;color:var(--muted);font-size:13px;font-weight:600}
  .cand ol{margin:10px 0 0;padding-left:18px}
  .cand li{font-size:14px;margin:4px 0;color:#c7d0e8}
  .cand li b{color:var(--muted);font-weight:600}
  .err{color:var(--bad);font-size:14px;margin-top:14px;display:none}
  .foot{color:var(--muted);font-size:12px;margin-top:30px;text-align:center;line-height:1.7}
  .foot a{color:var(--brand);text-decoration:none}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:s .7s linear infinite;vertical-align:-3px;margin-right:8px}
  @keyframes s{to{transform:rotate(360deg)}}
  @media(max-width:480px){.row{grid-template-columns:1fr}h1{font-size:28px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo"><span class="dot">✉</span> mailmetero</div>
  <h1>Find anyone's professional email</h1>
  <p class="sub">Enter a name and their company, or paste a LinkedIn profile URL. We derive the most likely address and score how confident we are — no scraping.</p>

  <div class="card">
    <label for="li">LinkedIn profile URL <span style="font-weight:400">(optional — fills the name)</span></label>
    <input id="li" placeholder="https://www.linkedin.com/in/patrick-collison" autocomplete="off">
    <div class="row">
      <div><label for="name">Full name</label><input id="name" placeholder="Patrick Collison" autocomplete="off"></div>
      <div><label for="domain">Company domain</label><input id="domain" placeholder="stripe.com" autocomplete="off"></div>
    </div>
    <button id="go">Find email</button>
    <div class="hint">Tip: use the company's real email domain (e.g. <b>stripe.com</b>), not a marketing site.</div>
    <div class="err" id="err"></div>

    <div class="result" id="result">
      <div class="email" id="email"></div>
      <div class="badges" id="badges"></div>
      <div class="meter"><span id="bar"></span></div>
      <div class="hint" id="score"></div>
      <details class="cand" id="candBox"><summary id="candSum">Other candidates</summary><ol id="cand"></ol></details>
    </div>
  </div>

  <div class="foot">
    Powered by the <a href="/v2/openapi.json">mailmetero API</a> · derivation-only, no LinkedIn scraping.<br>
    Verification is off in this demo, so results are pattern + DNS scored (not SMTP-verified).
  </div>
</div>
<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  function fromLinkedIn(u){
    try{
      var m=/\\/in\\/([^\\/?#]+)/.exec(u||''); if(!m) return '';
      var slug=decodeURIComponent(m[1]).split('-').filter(function(t){return t && !/^\\d+$/.test(t) && !/^[0-9a-f]{6,}$/i.test(t)});
      if(slug.length<1) return '';
      return slug.slice(0,2).map(function(t){return t.charAt(0).toUpperCase()+t.slice(1)}).join(' ');
    }catch(e){return ''}
  }
  $('li').addEventListener('input',function(){var n=fromLinkedIn(this.value); if(n) $('name').value=n;});
  var STATUS_COLOR={valid:'--good',accept_all:'--warn',unknown:'--warn',invalid:'--bad',disposable:'--bad',webmail:'--warn',role:'--warn'};
  function pill(text,varname){var c=varname?'var('+varname+')':'var(--line)';return '<span class="pill" style="border-color:'+c+';color:'+c+'">'+text+'</span>'}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function find(){
    var name=$('name').value.trim(), domain=$('domain').value.trim();
    $('err').style.display='none'; $('result').style.display='none';
    if(!name){$('err').textContent='Enter a name.';$('err').style.display='block';return}
    if(!domain){$('err').textContent='Enter a company domain.';$('err').style.display='block';return}
    var parts=name.split(/\\s+/); var first=parts[0]||''; var last=parts.length>1?parts[parts.length-1]:'';
    var qs='first_name='+encodeURIComponent(first)+'&last_name='+encodeURIComponent(last)+'&domain='+encodeURIComponent(domain);
    var btn=$('go'); btn.disabled=true; var old=btn.innerHTML; btn.innerHTML='<span class="spin"></span>Finding…';
    window.fetch('/app/find?'+qs).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(res){
      btn.disabled=false; btn.innerHTML=old;
      if(!res.ok){$('err').textContent=res.j.message||res.j.error||'Something went wrong.';$('err').style.display='block';return}
      var d=res.j.data;
      $('email').textContent=d.email||'No confident match';
      var badges=pill(d.status, STATUS_COLOR[d.status]);
      if(d.provider) badges+=pill(d.provider);
      if(d.backend) badges+=pill('verify: '+d.backend);
      $('badges').innerHTML=badges;
      var s=Math.max(0,Math.min(100,d.score||0));
      $('bar').style.width=s+'%';
      $('score').textContent='Confidence '+s+'/100 · '+(d.reason_codes||[]).slice(0,3).join(', ');
      var cands=(d.candidates||[]).filter(function(c){return c.email!==d.email});
      if(cands.length){
        $('candSum').textContent=cands.length+' other candidate'+(cands.length>1?'s':'');
        $('cand').innerHTML=cands.map(function(c){return '<li>'+esc(c.email)+' <b>· '+c.score+'</b></li>'}).join('');
        $('candBox').style.display='block';
      } else { $('candBox').style.display='none'; }
      $('result').style.display='block';
    }).catch(function(){btn.disabled=false;btn.innerHTML=old;$('err').textContent='Network error.';$('err').style.display='block';});
  }
  $('go').addEventListener('click',find);
  ['name','domain'].forEach(function(id){$(id).addEventListener('keydown',function(e){if(e.key==='Enter')find()})});
})();
</script>
</body>
</html>`;
