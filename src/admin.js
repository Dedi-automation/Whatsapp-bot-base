'use strict';

// B11 Admin dashboard: the agent's lead board (stage 2).
//
// Rewrite of MyDoctor admin.js and admin-pipeline-routes.js, not a copy (CLAUDE.md rule 5).
// - F-01, F-21: every page is built with the `html` tag from src/html.js, which
//   escapes every value. A value from the database can never become markup.
// - F-04, F-05: no token in any URL. The agent logs in once with the admin token
//   (ADMIN_TOKEN) on a form; the server sets a signed session cookie (HttpOnly,
//   Secure, SameSite=Strict). A request with a token in the URL is refused (T-16).
//   Changes are POST only, with a CSRF field tied to the session. Nothing changes on GET.
//   Scripts may send "Authorization: Bearer <token>" instead of the cookie.
// - F-12: lead fields are read by field ID, with the label from the bot's schema
//   (B4), never by position.
// - F-13: the status filter compares trimmed values.
// - Shows: leads (conversations) with a status filter, one lead with its transcript
//   and media, status change; test-mode trials with notes, media and prompt
//   recommendations, which only the owner approves or rejects (decisions.md item 34).
// - Outbound (base 1.1.0, decisions.md items 46 to 51), when the bot has an outbound
//   module: send a signup link to one phone, the daily limit and its weekly ramp,
//   campaigns (create, upload a CSV or pasted list, start, pause, status per
//   recipient) and the opt-out list. The list upload is the only multipart form.
// - No billing, commissions or employees (outside the base).
//
// The session cookie is stateless: `<expiry>.<signature>`, signed with HMAC-SHA256
// keyed by the admin token. Changing ADMIN_TOKEN logs everyone out. Several server
// instances accept the same cookie, so no session store is needed.
//
// Logs never contain tokens, phone numbers or message text.

const crypto = require('node:crypto');
const { html, raw } = require('./html');
const { checkBearerToken } = require('./security');
const { headerFor } = require('./schema');
const { MESSAGES, CONVERSATIONS } = require('./conversation');
const { OutboundError } = require('./errors');
const { parseRecipientList, decodeText } = require('./outbound');

const COOKIE = 'admin_session';
const MAX_FORM_BYTES = 16 * 1024;
// A list of 5,000 phones and names is about 150 KB; a Hebrew CSV with more columns is larger.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_RECIPIENT_ROWS = 500;
const UPLOAD_PATH = /^\/admin\/campaigns\/[^/]+\/recipients$/;

const CAMPAIGN_STATUS = { draft: 'טיוטה', running: 'פועל', paused: 'מושהה', paused_auto: 'נעצר אוטומטית', done: 'הסתיים' };
const RECIPIENT_STATUS = { pending: 'ממתין', sent: 'נשלח', delivered: 'נמסר', read: 'נקרא', replied: 'ענה', failed: 'נכשל', opted_out: 'הוסר לפי בקשה' };
const SIGNUP_RESULT = {
  sent: 'הלינק נשלח.',
  invalid_phone: 'מספר הטלפון לא תקין.',
  opted_out: 'הלקוח ביקש לא לקבל הודעות. לא נשלח.',
  outside_window: 'מחוץ לשעות השליחה ללקוחות (ראשון עד חמישי, 09:00 עד 17:50). לא נשלח.',
  failed: 'השליחה נכשלה. פרטים ברשימת השליחות.',
};
const MIN_TOKEN_LENGTH = 16;
const DEFAULT_SESSION_HOURS = 12;
const SESSIONS = 'test_sessions';
const IMPROVEMENTS = 'improvements';
const RECOMMENDATIONS = 'recommendations';
const MEDIA = 'media';

// Served inline only for images. Anything else is a download, so a stored file
// can never run as a page in the dashboard's origin.
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DOWNLOAD_TYPES = new Set(['application/pdf', 'audio/ogg', 'audio/mpeg', 'video/mp4']);

const DEFAULT_LEAD_FIELDS = [
  ['customerPhone', 'טלפון'],
  ['status', 'סטטוס'],
  ['callbackDate', 'תאריך חזרה'],
  ['agent_action_required', 'דורש טיפול'],
  ['lastMessageAt', 'הודעה אחרונה'],
];

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
};

/**
 * @param {{
 *   adminToken: string,
 *   storage: import('./storage').Storage,
 *   statuses: string[],
 *   testMode?: {decideRecommendation: (input: {id: string, decision: 'approved' | 'rejected', decidedBy: string}) => Promise<unknown>},
 *   outbound?: ReturnType<typeof import('./outbound').createOutbound>,
 *   schema?: import('./schema').Schema,
 *   leadsTab?: string,
 *   leadFields?: string[],
 *   botName?: string,
 *   now?: () => Date,
 *   sessionHours?: number,
 *   secureCookie?: boolean,
 *   log?: {info: (...args: unknown[]) => void, error: (...args: unknown[]) => void}
 * }} deps
 *   statuses: the lead statuses the agent may set (per bot, from config).
 *   leadFields: field IDs shown on the board; labels come from schema[leadsTab] (F-12).
 *     Without a schema, the default fields above are shown.
 *   secureCookie: false only for tests over plain http on localhost.
 * @returns {{handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}}
 *   handle answers every request whose path starts with /admin.
 * Errors: TypeError at startup when the token is shorter than 16 characters or statuses is empty.
 */
function createAdmin(deps) {
  const { adminToken, storage, statuses, testMode, outbound, schema, leadsTab = CONVERSATIONS } = deps || {};
  const { botName = '', now = () => new Date(), sessionHours = DEFAULT_SESSION_HOURS, secureCookie = true, log = console } = deps || {};
  if (typeof adminToken !== 'string' || adminToken.length < MIN_TOKEN_LENGTH) {
    throw new TypeError(`ADMIN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (!Array.isArray(statuses) || statuses.length === 0 || !statuses.every((s) => typeof s === 'string' && s.trim() !== '')) {
    throw new TypeError('statuses must be a non-empty list of lead statuses');
  }
  const leadFields = resolveLeadFields(schema, leadsTab, deps.leadFields);
  // With campaigns and the default columns, the board shows which campaign a lead answered.
  if (outbound && !schema) leadFields.push(['campaignName', 'קמפיין']);

  // ---- session cookie and CSRF ----

  const sign = (purpose, value) =>
    crypto.createHmac('sha256', adminToken).update(`${purpose}:${value}`).digest('base64url');

  function newSessionCookie() {
    const expiry = now().getTime() + sessionHours * 3600 * 1000;
    return `${expiry}.${sign('session', expiry)}`;
  }

  /** @returns {string | null} the session value when valid and not expired */
  function validSession(req) {
    const value = readCookie(req.headers.cookie, COOKIE);
    if (!value) return null;
    const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match) return null;
    if (!safeEqual(match[2], sign('session', match[1]))) return null;
    if (Number(match[1]) <= now().getTime()) return null;
    return value;
  }

  const csrfFor = (session) => sign('csrf', session);

  function setCookie(res, value, maxAgeSeconds) {
    const parts = [`${COOKIE}=${value}`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (secureCookie) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // ---- routing ----

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // F-04, T-16: a token in the URL may already be in logs; refuse the request.
    if (tokenInUrl(req.url, url)) {
      log.error('admin: rejected, token in URL');
      return page(res, 400, 'שגיאה', html`<p>אין לשלוח טוקן בכתובת. היכנסו דרך דף הכניסה.</p>`);
    }

    if (path === '/admin/login') {
      if (req.method === 'GET') return loginPage(res, 200, false);
      if (req.method === 'POST') return login(req, res);
      return methodNotAllowed(res);
    }

    const bearer = req.headers.authorization !== undefined;
    const session = bearer ? null : validSession(req);
    if (bearer ? !checkBearerToken({ url: req.url, headers: req.headers, expected: adminToken }) : !session) {
      if (req.method === 'GET' && !bearer) return redirect(res, '/admin/login');
      return page(res, 401, 'אין הרשאה', html`<p>יש להיכנס מחדש.</p>`);
    }

    if (req.method === 'POST') {
      let form;
      try {
        form = await readForm(req, UPLOAD_PATH.test(path) ? { maxBytes: MAX_UPLOAD_BYTES, multipart: true } : {});
      } catch (err) {
        return page(res, err.statusCode || 400, 'שגיאה', html`<p>${err.statusCode === 413 ? 'הקובץ גדול מדי.' : 'הבקשה לא תקינה.'}</p>`);
      }
      // Cookie sessions need the CSRF field; a Bearer client is not a browser.
      if (!bearer && !safeEqual(String(form.csrf || ''), csrfFor(session))) {
        return page(res, 403, 'שגיאה', html`<p>הטופס פג תוקף. רעננו את הדף ונסו שוב.</p>`);
      }
      try {
        return await post(req, res, path, form, session);
      } catch (err) {
        if (!(err instanceof OutboundError)) throw err;
        return page(res, 400, 'שגיאה', html`<p>${err.message}</p><p><a href="/admin/outbound">חזרה</a></p>`, csrfFor(session || ''));
      }
    }
    if (req.method !== 'GET') return methodNotAllowed(res);
    return get(res, path, url, session);
  }

  async function get(res, path, url, session) {
    const csrf = session ? csrfFor(session) : '';
    if (path === '/admin') return redirect(res, '/admin/leads');
    if (path === '/admin/leads') return leadsPage(res, url, csrf);
    if (path === '/admin/trials') return trialsPage(res, csrf);
    let m;
    if ((m = /^\/admin\/leads\/([^/]+)$/.exec(path))) return leadPage(res, decodeId(m[1]), csrf);
    if ((m = /^\/admin\/trials\/([^/]+)$/.exec(path))) return trialPage(res, decodeId(m[1]), csrf);
    if ((m = /^\/admin\/recommendations\/([^/]+)$/.exec(path))) return recommendationPage(res, decodeId(m[1]), csrf);
    if ((m = /^\/admin\/media\/([^/]+)$/.exec(path))) return mediaFile(res, decodeId(m[1]));
    if (outbound) {
      if (path === '/admin/outbound') return outboundPage(res, url, csrf);
      if (path === '/admin/optouts') return optOutsPage(res, url, csrf);
      if ((m = /^\/admin\/campaigns\/([^/]+)$/.exec(path))) return campaignPage(res, decodeId(m[1]), url, csrf);
    }
    return notFound(res);
  }

  async function post(req, res, path, form) {
    if (path === '/admin/logout') {
      setCookie(res, '', 0);
      return redirect(res, '/admin/login');
    }
    let m;
    if ((m = /^\/admin\/leads\/([^/]+)\/status$/.exec(path))) return changeStatus(res, decodeId(m[1]), form);
    if ((m = /^\/admin\/recommendations\/([^/]+)\/decision$/.exec(path))) return decide(res, decodeId(m[1]), form);
    if (outbound) {
      if (path === '/admin/outbound/signup') return sendSignup(res, form);
      if (path === '/admin/outbound/ramp') return saveRamp(res, form);
      if (path === '/admin/optouts') return addOptOut(res, form);
      if (path === '/admin/campaigns') return newCampaign(res, form);
      if ((m = /^\/admin\/campaigns\/([^/]+)\/recipients$/.exec(path))) return uploadRecipients(res, decodeId(m[1]), form);
      if ((m = /^\/admin\/campaigns\/([^/]+)\/status$/.exec(path))) return campaignStatus(res, decodeId(m[1]), form);
    }
    return notFound(res);
  }

  // ---- login ----

  async function login(req, res) {
    let form;
    try {
      form = await readForm(req);
    } catch (err) {
      return loginPage(res, err.statusCode || 400, true);
    }
    if (!safeEqual(String(form.token || ''), adminToken)) {
      log.error('admin: failed login');
      return loginPage(res, 401, true);
    }
    setCookie(res, newSessionCookie(), sessionHours * 3600);
    log.info('admin: login');
    return redirect(res, '/admin/leads');
  }

  function loginPage(res, status, failed) {
    return page(
      res,
      status,
      'כניסה',
      html`${failed ? html`<p class="error">הכניסה נכשלה.</p>` : ''}
<form method="post" action="/admin/login">
  <label>קוד כניסה <input type="password" name="token" autocomplete="current-password" required></label>
  <button type="submit">כניסה</button>
</form>`,
      ''
    );
  }

  // ---- leads ----

  async function leadsPage(res, url, csrf) {
    const filter = (url.searchParams.get('status') || '').trim();
    const leads = (await storage.list(leadsTab))
      .filter((lead) => !filter || String(lead.data.status ?? '').trim() === filter)
      .sort((a, b) => String(b.data.lastMessageAt ?? '').localeCompare(String(a.data.lastMessageAt ?? '')));

    const options = statuses.map((s) => html`<option value="${s}"${s === filter ? raw(' selected') : ''}>${s}</option>`);
    const rows = leads.map(
      (lead) => html`<tr${lead.data.agent_action_required === true ? raw(' class="action"') : ''}>
  <td><a href="/admin/leads/${encodeURIComponent(lead.id)}">${lead.id}</a></td>
  ${leadFields.map(([id]) => html`<td>${display(lead.data[id])}</td>`)}
</tr>`
    );
    return page(
      res,
      200,
      'לידים',
      html`<form method="get" action="/admin/leads">
  <label>סטטוס <select name="status"><option value="">הכול</option>${options}</select></label>
  <button type="submit">סינון</button>
</form>
<p>${leads.length} לידים</p>
<table>
  <thead><tr><th>מזהה</th>${leadFields.map(([, label]) => html`<th>${label}</th>`)}</tr></thead>
  <tbody>${rows}</tbody>
</table>`,
      csrf
    );
  }

  async function leadPage(res, id, csrf) {
    if (!id) return notFound(res);
    const lead = await storage.get(leadsTab, id);
    if (!lead) return notFound(res);
    const transcript = await listByPrefix(MESSAGES, `${id}:`);
    const mediaIds = await storedMediaIds(`${id}:`);

    const fields = leadFields.map(([fid, label]) => html`<tr><th>${label}</th><td>${display(lead[fid])}</td></tr>`);
    const messages = transcript.map((r) => {
      const d = r.data;
      const media = d.media && mediaIds.has(r.id) ? mediaLink(r.id, d.mediaType) : d.media ? html`<em>[${d.mediaType || 'קובץ'} לא נשמר]</em>` : '';
      return html`<li class="${d.role === 'user' ? 'user' : 'bot'}"><small>${d.at}</small> ${d.text}${d.kind && d.kind !== 'text' && !d.media ? html`<em>[${d.mediaType || d.kind}]</em>` : ''} ${media}</li>`;
    });
    const options = statuses.map((s) => html`<option value="${s}"${s === lead.status ? raw(' selected') : ''}>${s}</option>`);
    return page(
      res,
      200,
      `ליד ${id}`,
      html`<p><a href="/admin/leads">חזרה ללידים</a></p>
<table>${fields}</table>
<form method="post" action="/admin/leads/${encodeURIComponent(id)}/status">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>שינוי סטטוס <select name="status">${options}</select></label>
  <button type="submit">שמירה</button>
</form>
<h2>שיחה</h2>
<ol class="transcript">${messages}</ol>`,
      csrf
    );
  }

  async function changeStatus(res, id, form) {
    const status = String(form.status || '').trim();
    if (!statuses.includes(status)) return page(res, 400, 'שגיאה', html`<p>סטטוס לא מוכר.</p>`);
    const lead = id ? await storage.get(leadsTab, id) : null;
    if (!lead) return notFound(res);
    await storage.set(leadsTab, id, { ...lead, status, statusChangedAt: now().toISOString() });
    log.info('admin: lead status changed');
    return redirect(res, `/admin/leads/${encodeURIComponent(id)}`);
  }

  // ---- test mode: trials, notes, recommendations ----

  async function trialsPage(res, csrf) {
    const trials = (await storage.list(SESSIONS)).sort((a, b) => String(b.data.endedAt ?? '').localeCompare(String(a.data.endedAt ?? '')));
    const rows = trials.map(
      (t) => html`<tr><td><a href="/admin/trials/${encodeURIComponent(t.id)}">${t.id}</a></td><td>${t.data.status}</td><td>${t.data.answerCount}</td><td>${t.data.endedAt}</td></tr>`
    );
    return page(
      res,
      200,
      'ניסיונות (מצב בדיקה)',
      html`<table><thead><tr><th>ניסיון</th><th>מצב</th><th>תשובות</th><th>הסתיים</th></tr></thead><tbody>${rows}</tbody></table>`,
      csrf
    );
  }

  async function trialPage(res, trialId, csrf) {
    if (!trialId) return notFound(res);
    const session = await storage.get(SESSIONS, trialId);
    if (!session) return notFound(res);
    const notes = await listByPrefix(IMPROVEMENTS, `${trialId}:`);
    const mediaIds = await storedMediaIds(`${trialId}:`);
    const recs = await listByPrefix(RECOMMENDATIONS, `${trialId}:`);

    const noteItems = notes.map((n) => {
      const media = n.data.media
        ? mediaIds.has(n.id)
          ? mediaLink(n.id, n.data.media.type)
          : html`<em>[${n.data.media.type} לא נשמר: ${n.data.media.detail}]</em>`
        : '';
      return html`<li><strong>${n.data.question || 'הערה'}</strong><br>${n.data.answer} ${media}</li>`;
    });
    return page(
      res,
      200,
      `ניסיון ${trialId}`,
      html`<p><a href="/admin/trials">חזרה לניסיונות</a></p>
<h2>הערות</h2><ol>${noteItems}</ol>
<h2>הצעות לשיפור הפרומפט</h2>${recs.map((r) => recommendationBlock(r.id, r.data, csrf))}`,
      csrf
    );
  }

  async function recommendationPage(res, id, csrf) {
    const rec = id ? await storage.get(RECOMMENDATIONS, id) : null;
    if (!rec) return notFound(res);
    return page(
      res,
      200,
      'הצעה לשיפור',
      html`<p><a href="/admin/trials/${encodeURIComponent(rec.trialId || '')}">לניסיון</a></p>${recommendationBlock(id, rec, csrf)}`,
      csrf
    );
  }

  function recommendationBlock(id, rec, csrf) {
    const pending = rec.status === 'pending_approval';
    const form = pending
      ? html`<form method="post" action="/admin/recommendations/${encodeURIComponent(id)}/decision">
  <input type="hidden" name="csrf" value="${csrf}">
  <button type="submit" name="decision" value="approved">אישור</button>
  <button type="submit" name="decision" value="rejected">דחייה</button>
</form>`
      : html`<p>החלטה: ${rec.status} (${rec.decidedAt})</p>`;
    return html`<section class="rec">
  <h3>${rec.summary}</h3>
  <p><strong>השינוי:</strong></p><pre>${rec.change}</pre>
  <p><strong>נימוק:</strong> ${rec.reason}</p>
  <p>אישור לא משנה את הפרומפט אוטומטית. השינוי נעשה בנפרד.</p>
  ${form}
</section>`;
  }

  async function decide(res, id, form) {
    if (!testMode || typeof testMode.decideRecommendation !== 'function') return notFound(res);
    const decision = form.decision;
    if (decision !== 'approved' && decision !== 'rejected') return page(res, 400, 'שגיאה', html`<p>החלטה לא מוכרת.</p>`);
    try {
      await testMode.decideRecommendation({ id, decision, decidedBy: 'admin' });
    } catch (err) {
      log.error(`admin: decision failed: ${err.name}`);
      return page(res, 409, 'שגיאה', html`<p>לא ניתן לשמור את ההחלטה: ${err.message}</p>`);
    }
    return redirect(res, `/admin/recommendations/${encodeURIComponent(id)}`);
  }

  // ---- outbound: signup links, daily limit, campaigns, opt-outs ----

  async function outboundPage(res, url, csrf) {
    const day = await outbound.todayStatus();
    const campaigns = await outbound.listCampaigns();
    const signups = (await outbound.listSignups()).slice(0, 20);
    const result = SIGNUP_RESULT[url.searchParams.get('signup')] || '';
    const saved = url.searchParams.get('saved') === 'ramp' ? 'ההגדרות נשמרו.' : '';
    const templateOptions = Object.entries(outbound.templates).map(([key, def]) => html`<option value="${key}">${def.label || def.name}</option>`);
    const rows = campaigns.map(
      (c) => html`<tr><td><a href="/admin/campaigns/${encodeURIComponent(c.id)}">${c.data.name}</a></td><td>${CAMPAIGN_STATUS[c.data.status] || c.data.status}</td><td>${c.data.total}</td><td>${c.data.sent}</td><td>${c.data.failed}</td><td>${c.data.skipped}</td></tr>`
    );
    const r = day.ramp;
    return page(
      res,
      200,
      'הודעות יזומות',
      html`${result ? html`<p class="notice">${result}</p>` : ''}${saved ? html`<p class="notice">${saved}</p>` : ''}
<h2>היום</h2>
<p>שבוע ${day.week} · מכסה היום: ${day.quota} · נשלחו היום: ${day.sent} · ${day.inWindow ? 'בתוך שעות השליחה' : 'מחוץ לשעות השליחה (ראשון עד חמישי, 09:00 עד 17:50)'}</p>
${outbound.hasSignup
  ? html`<h2>שליחת לינק הרשמה ללקוח</h2>
<form method="post" action="/admin/outbound/signup">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>טלפון <input name="phone" inputmode="tel" required></label>
  <label>שם (לא חובה) <input name="name"></label>
  <button type="submit">שליחה</button>
</form>
<table><thead><tr><th>טלפון</th><th>שם</th><th>מצב</th><th>זמן</th></tr></thead><tbody>${signups.map((s) => html`<tr><td>${s.data.phone}</td><td>${s.data.name}</td><td>${RECIPIENT_STATUS[s.data.status] || s.data.status}${s.data.error ? html` <small>${s.data.error}</small>` : ''}</td><td>${s.data.at}</td></tr>`)}</tbody></table>`
  : ''}
<h2>קמפיינים</h2>
<table><thead><tr><th>שם</th><th>מצב</th><th>נמענים</th><th>נשלחו</th><th>נכשלו</th><th>הוסרו</th></tr></thead><tbody>${rows}</tbody></table>
${templateOptions.length > 0
  ? html`<form method="post" action="/admin/campaigns">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>קמפיין חדש <input name="name" required></label>
  <label>תבנית <select name="templateKey">${templateOptions}</select></label>
  <button type="submit">יצירה</button>
</form>`
  : html`<p>לבוט הזה לא הוגדרו תבניות קמפיין.</p>`}
<h2>מכסה יומית למספר</h2>
<p>משותפת לכל הקמפיינים. השבוע הראשון מתחיל ביום שבו הקמפיין הראשון הופעל${r.startDate ? html` (${r.startDate})` : ''}.</p>
<form method="post" action="/admin/outbound/ramp">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>ביום בשבוע הראשון <input name="startPerDay" inputmode="numeric" value="${r.startPerDay}" required></label>
  <label>תוספת כל שבוע <input name="stepPerWeek" inputmode="numeric" value="${r.stepPerWeek}" required></label>
  <label>תקרה ביום (ריק = בלי תקרה) <input name="maxPerDay" inputmode="numeric" value="${r.maxPerDay === null ? '' : r.maxPerDay}"></label>
  <button type="submit">שמירה</button>
</form>
<p><a href="/admin/optouts">רשימת המוסרים</a></p>`,
      csrf
    );
  }

  async function sendSignup(res, form) {
    const result = await outbound.sendSignupLink({ phone: String(form.phone || ''), name: String(form.name || '') });
    return redirect(res, `/admin/outbound?signup=${result.status}`);
  }

  async function saveRamp(res, form) {
    await outbound.updateRamp({ startPerDay: String(form.startPerDay ?? ''), stepPerWeek: String(form.stepPerWeek ?? ''), maxPerDay: String(form.maxPerDay ?? '').trim() });
    return redirect(res, '/admin/outbound?saved=ramp');
  }

  async function newCampaign(res, form) {
    const id = await outbound.createCampaign({ name: String(form.name || ''), templateKey: String(form.templateKey || '') });
    return redirect(res, `/admin/campaigns/${encodeURIComponent(id)}`);
  }

  async function campaignPage(res, id, url, csrf) {
    const campaign = await outbound.getCampaign(id);
    if (!campaign) return notFound(res);
    const all = await outbound.listRecipients(id);
    const counts = {};
    for (const r of all) counts[r.data.status] = (counts[r.data.status] || 0) + 1;
    const filter = (url.searchParams.get('status') || '').trim();
    const shown = all.filter((r) => !filter || r.data.status === filter);
    const added = url.searchParams.get('added');
    const day = await outbound.todayStatus();
    const template = outbound.templates[campaign.templateKey];
    const action = campaign.status === 'running'
      ? html`<button type="submit" name="action" value="pause">עצירה</button>`
      : campaign.status !== 'done'
        ? html`<button type="submit" name="action" value="start">${campaign.status === 'draft' ? 'הפעלה' : 'המשך שליחה'}</button>`
        : '';
    return page(
      res,
      200,
      `קמפיין ${campaign.name}`,
      html`<p><a href="/admin/outbound">חזרה להודעות יזומות</a></p>
${added !== null ? html`<p class="notice">נוספו ${added} נמענים. כפולים: ${url.searchParams.get('dup') || 0}. שורות לא תקינות: ${url.searchParams.get('invalid') || 0}.</p>` : ''}
<p>מצב: <strong>${CAMPAIGN_STATUS[campaign.status] || campaign.status}</strong>${campaign.pauseReason ? html` · ${campaign.pauseReason}` : ''}</p>
<p>תבנית: ${template ? template.label || template.name : campaign.templateKey} · נמענים: ${campaign.total} · מכסה היום למספר: ${day.quota}, נשלחו היום: ${day.sent}</p>
<p>${Object.entries(RECIPIENT_STATUS).map(([key, label]) => html`<a href="/admin/campaigns/${encodeURIComponent(id)}?status=${key}">${label}: ${counts[key] || 0}</a> · `)}<a href="/admin/campaigns/${encodeURIComponent(id)}">הכול</a></p>
${action ? html`<form method="post" action="/admin/campaigns/${encodeURIComponent(id)}/status"><input type="hidden" name="csrf" value="${csrf}">${action}</form>` : ''}
<h2>הוספת נמענים</h2>
<p>קובץ CSV (בשמירה מאקסל: "CSV") או הדבקה, שורה לכל לקוח: טלפון ושם, מופרדים בפסיק. מספר שמופיע כבר בקמפיין לא יתווסף שוב.</p>
<form method="post" action="/admin/campaigns/${encodeURIComponent(id)}/recipients" enctype="multipart/form-data">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>קובץ <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain"></label>
  <label>או הדבקה <textarea name="list" rows="6" cols="40"></textarea></label>
  <button type="submit">הוספה</button>
</form>
<h2>נמענים${filter ? html` (${RECIPIENT_STATUS[filter] || filter})` : ''}</h2>
${shown.length > MAX_RECIPIENT_ROWS ? html`<p>מוצגים ${MAX_RECIPIENT_ROWS} הראשונים מתוך ${shown.length}.</p>` : ''}
<table><thead><tr><th>#</th><th>טלפון</th><th>שם</th><th>מצב</th><th>נשלח</th><th>תשובה</th><th>שגיאה</th></tr></thead><tbody>${shown
        .slice(0, MAX_RECIPIENT_ROWS)
        .map(
          (r) => html`<tr${r.data.status === 'replied' ? raw(' class="action"') : ''}><td>${r.data.index + 1}</td><td>${r.data.reply !== undefined ? html`<a href="/admin/leads/${encodeURIComponent(r.data.phone)}">${r.data.phone}</a>` : r.data.phone}</td><td>${r.data.name}</td><td>${RECIPIENT_STATUS[r.data.status] || r.data.status}</td><td>${r.data.sentAt}</td><td>${r.data.reply}</td><td>${r.data.error}</td></tr>`
        )}</tbody></table>`,
      csrf
    );
  }

  async function uploadRecipients(res, id, form) {
    const parts = [];
    const files = form._files;
    if (files && Buffer.isBuffer(files.file) && files.file.length > 0) parts.push(decodeText(files.file));
    if (typeof form.list === 'string' && form.list.trim() !== '') parts.push(form.list);
    if (parts.length === 0) throw new OutboundError('לא נבחר קובץ ולא הודבקה רשימה');
    const { rows, invalid } = parseRecipientList(parts.join('\n'));
    const result = await outbound.addRecipients(id, rows);
    const q = new URLSearchParams({ added: String(result.added), dup: String(result.duplicates), invalid: String(invalid.length + result.invalid) });
    return redirect(res, `/admin/campaigns/${encodeURIComponent(id)}?${q}`);
  }

  async function campaignStatus(res, id, form) {
    await outbound.setStatus(id, String(form.action || ''));
    return redirect(res, `/admin/campaigns/${encodeURIComponent(id)}`);
  }

  async function optOutsPage(res, url, csrf) {
    const list = await outbound.listOptOuts();
    return page(
      res,
      200,
      'רשימת המוסרים',
      html`<p><a href="/admin/outbound">חזרה להודעות יזומות</a></p>
${url.searchParams.get('added') === '1' ? html`<p class="notice">המספר נוסף לרשימה.</p>` : ''}
<p>מספרים ברשימה לא יקבלו קמפיין או לינק הרשמה מהבוט. אי אפשר להוציא מספר מהרשימה בלוח.</p>
<form method="post" action="/admin/optouts">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>הוספת מספר <input name="phone" inputmode="tel" required></label>
  <button type="submit">הוספה</button>
</form>
<p>${list.length} מספרים</p>
<table><thead><tr><th>טלפון</th><th>מקור</th><th>זמן</th></tr></thead><tbody>${list.map((o) => html`<tr><td>${o.id}</td><td>${o.data.source === 'keyword' ? 'הלקוח ביקש' : 'נוסף בלוח'}</td><td>${o.data.at}</td></tr>`)}</tbody></table>`,
      csrf
    );
  }

  async function addOptOut(res, form) {
    await outbound.recordOptOut({ phone: String(form.phone || ''), source: 'admin' });
    return redirect(res, '/admin/optouts?added=1');
  }

  // ---- media ----

  function mediaLink(id, type) {
    const href = `/admin/media/${encodeURIComponent(id)}`;
    return type === 'image' || type === 'sticker'
      ? html`<a href="${href}"><img src="${href}" alt="${type}" class="thumb"></a>`
      : html`<a href="${href}">[${type || 'קובץ'}]</a>`;
  }

  async function mediaFile(res, id) {
    const file = id ? await storage.get(MEDIA, id) : null;
    if (!file || typeof file.data !== 'string') return notFound(res);
    const type = String(file.mimeType || '').split(';')[0].trim().toLowerCase();
    const inline = INLINE_TYPES.has(type);
    const contentType = inline || DOWNLOAD_TYPES.has(type) ? type : 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Disposition': inline ? 'inline' : 'attachment',
    });
    return res.end(Buffer.from(file.data, 'base64'));
  }

  // ---- helpers ----

  /** IDs of media records under a prefix that hold a file (a failed download keeps only the reason). */
  async function storedMediaIds(prefix) {
    return new Set((await listByPrefix(MEDIA, prefix)).filter((r) => typeof r.data.data === 'string').map((r) => r.id));
  }

  async function listByPrefix(collection, prefix) {
    return (await storage.list(collection))
      .filter((r) => r.id.startsWith(prefix))
      .sort((a, b) => seqOf(a.id) - seqOf(b.id));
  }

  function page(res, status, title, body, csrf) {
    const nav = csrf
      ? html`<nav><a href="/admin/leads">לידים</a> · <a href="/admin/trials">מצב בדיקה</a>${outbound ? html` · <a href="/admin/outbound">הודעות יזומות</a>` : ''}
  <form method="post" action="/admin/logout" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">יציאה</button></form></nav>`
      : '';
    const doc = html`<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}${botName ? ` · ${botName}` : ''}</title>
<style>${raw(STYLE)}</style>
</head>
<body>
${nav}
<h1>${title}</h1>
${body}
</body>
</html>`;
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(String(doc));
  }

  function redirect(res, location) {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: location });
    res.end();
  }

  function notFound(res) {
    return page(res, 404, 'לא נמצא', html`<p>הדף לא נמצא.</p>`);
  }

  function methodNotAllowed(res) {
    return page(res, 405, 'שגיאה', html`<p>פעולה לא נתמכת.</p>`);
  }

  function tokenInUrl(rawUrl, url) {
    if (url.searchParams.has('token')) return true;
    let decoded = rawUrl;
    try {
      decoded = decodeURIComponent(rawUrl);
    } catch {
      // keep raw
    }
    return rawUrl.includes(adminToken) || decoded.includes(adminToken);
  }

  return { handle };
}

/** Field IDs and labels for the board. Labels come from the schema (F-12). */
function resolveLeadFields(schema, tab, fieldIds) {
  if (!schema) {
    if (fieldIds) throw new TypeError('leadFields needs a schema for the labels');
    return [...DEFAULT_LEAD_FIELDS];
  }
  const ids = fieldIds || Object.keys((schema[tab] && schema[tab].fields) || {});
  // headerFor throws SchemaError for an unknown field, so a typo fails at startup.
  return ids.map((id) => [id, headerFor(schema, tab, id)]);
}

function display(value) {
  if (value === true) return 'כן';
  if (value === false) return 'לא';
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function decodeId(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

function seqOf(id) {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isFinite(n) ? n : 0;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function readForm(req, { maxBytes = MAX_FORM_BYTES, multipart = false } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '');
    const type = contentType.split(';')[0].trim().toLowerCase();
    const boundary = (/boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType) || []).slice(1).find(Boolean);
    const isMultipart = multipart && type === 'multipart/form-data' && boundary;
    if (type !== 'application/x-www-form-urlencoded' && !isMultipart) {
      const err = new Error('form expected');
      err.statusCode = 415;
      req.resume();
      reject(err);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('form too large');
        err.statusCode = 413;
        req.removeAllListeners('data');
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (!isMultipart) return resolve(Object.fromEntries(new URLSearchParams(body.toString('utf8'))));
      const { fields, files } = parseMultipart(body, boundary);
      return resolve({ ...fields, _files: files });
    });
    req.on('error', reject);
  });
}

/**
 * Fields and files of a multipart/form-data body. Text fields are UTF-8 strings,
 * files are Buffers (decoded by the caller). Parts without a name are skipped.
 */
function parseMultipart(body, boundary) {
  const fields = {};
  const files = {};
  const delimiter = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    let start = pos + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body.subarray(start, start + 2).toString() === '\r\n') start += 2;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start, Math.max(start, next - 2));
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const name = /\bname="([^"]*)"/i.exec(headers);
      if (name && name[1] !== '_files') {
        if (/\bfilename="/i.test(headers)) files[name[1]] = Buffer.from(content);
        else fields[name[1]] = content.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

const STYLE = `
body { font-family: system-ui, sans-serif; margin: 16px; line-height: 1.5; color: #1a1a1a; background: #fff; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: start; vertical-align: top; }
tr.action { background: #fff4e5; }
nav { margin-bottom: 12px; }
form.inline { display: inline; }
.error { color: #b00020; }
.transcript li.user { color: #0b4f9c; }
.thumb { max-width: 160px; max-height: 160px; }
pre { white-space: pre-wrap; background: #f5f5f5; padding: 8px; }
.rec { border: 1px solid #ddd; padding: 8px 12px; margin: 12px 0; }
.notice { background: #eef6ee; padding: 6px 10px; }
label { display: inline-block; margin: 4px 8px 4px 0; }
`;

module.exports = { createAdmin, parseMultipart, COOKIE, MIN_TOKEN_LENGTH };
