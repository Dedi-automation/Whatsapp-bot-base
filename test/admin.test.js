'use strict';

// B11 Admin dashboard (agent lead board). Covers F-01 and F-21 (escaping),
// F-04 / T-16 (no token in URLs, login form and session cookie), F-05 (no change
// on GET, CSRF on POST), F-12 (fields by ID from the schema), media served safely,
// and recommendations decided by the owner only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdmin, COOKIE } = require('../src/admin');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { SchemaError } = require('../src/errors');

const TOKEN = 'admin-token-0123456789';
const XSS = `<script>alert('x')</script>`;
const NOW = new Date('2026-10-26T10:00:00Z');

async function setup(overrides = {}) {
  const storage = createMemoryStorage({ projectId: 'test-admin' });
  await storage.set('conversations', '972500000001', {
    customerPhone: '972500000001',
    status: 'new',
    callbackDate: '27/10/2026',
    agent_action_required: true,
    lastMessageAt: '2026-10-26T09:00:00Z',
    fullName: XSS,
  });
  await storage.set('conversations', '972500000002', { customerPhone: '972500000002', status: 'closed', lastMessageAt: '2026-10-25T09:00:00Z' });
  await storage.set('messages', '972500000001:1', { conversationId: '972500000001', seq: 1, role: 'user', kind: 'text', text: XSS, at: '2026-10-26T09:00:00Z' });
  await storage.set('messages', '972500000001:2', {
    conversationId: '972500000001', seq: 2, role: 'user', kind: 'unsupported', text: null, mediaType: 'image',
    media: { id: 'm1', mimeType: 'image/png' }, at: '2026-10-26T09:01:00Z',
  });
  await storage.set('media', '972500000001:2', { mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') });
  await storage.set('media', 'evil:1', { mimeType: 'text/html', data: Buffer.from('<script>x</script>').toString('base64') });
  await storage.set('test_sessions', 'trial-1', { status: 'closed', answerCount: 1, endedAt: '2026-10-26T08:00:00Z' });
  await storage.set('improvements', 'trial-1:1', { trialId: 'trial-1', question: 'What to fix?', answer: XSS });
  await storage.set('recommendations', 'trial-1:1', {
    trialId: 'trial-1', summary: XSS, change: 'Ask dates first', reason: 'feedback', status: 'pending_approval',
  });

  const decisions = [];
  const testMode = {
    async decideRecommendation({ id, decision, decidedBy }) {
      decisions.push({ id, decision, decidedBy });
      const rec = await storage.get('recommendations', id);
      await storage.set('recommendations', id, { ...rec, status: decision, decidedAt: NOW.toISOString(), decidedBy });
    },
  };
  const admin = createAdmin({
    adminToken: TOKEN,
    storage,
    statuses: ['new', 'in_progress', 'closed'],
    testMode,
    now: () => NOW,
    secureCookie: false,
    log: { info() {}, error() {} },
    ...overrides,
  });
  const server = http.createServer((req, res) => admin.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  return { storage, decisions, base, request, close: () => new Promise((r) => server.close(r)) };
}

async function login(request) {
  const res = await request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN }).toString(),
  });
  assert.equal(res.status, 303);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.ok(cookie.startsWith(`${COOKIE}=`));
  return cookie;
}

async function csrfFrom(request, cookie, path) {
  const body = await (await request(path, { headers: { cookie } })).text();
  return /name="csrf" value="([^"]+)"/.exec(body)[1];
}

function postForm(request, path, cookie, fields) {
  return request(path, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

test('startup: a short admin token or no statuses is refused', () => {
  const storage = createMemoryStorage({ projectId: 'test-admin' });
  assert.throws(() => createAdmin({ adminToken: 'short', storage, statuses: ['new'] }), /ADMIN_TOKEN/);
  assert.throws(() => createAdmin({ adminToken: TOKEN, storage, statuses: [] }), /statuses/);
});

test('F-12: lead fields come from the schema by ID; an unknown field fails at startup', () => {
  const storage = createMemoryStorage({ projectId: 'test-admin' });
  const schema = { conversations: { fields: { status: { header: 'Status' } } } };
  assert.throws(() => createAdmin({ adminToken: TOKEN, storage, statuses: ['new'], schema, leadFields: ['nope'] }), SchemaError);
  assert.doesNotThrow(() => createAdmin({ adminToken: TOKEN, storage, statuses: ['new'], schema, leadFields: ['status'] }));
});

test('without a session, pages redirect to the login form', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await s.request('/admin/leads');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/login');
  const form = await (await s.request('/admin/login')).text();
  assert.match(form, /type="password" name="token"/);
});

test('login: a wrong token is refused and sets no cookie', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await s.request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'token=wrong-token-0123456789',
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('F-04: the session cookie is HttpOnly, SameSite=Strict and Secure by default', async (t) => {
  const s = await setup({ secureCookie: true });
  t.after(s.close);
  const res = await s.request('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN }).toString(),
  });
  const header = res.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/);
  assert.ok(!header.includes(TOKEN), 'cookie does not carry the token');
});

test('T-16/F-04: a token in the URL is refused, even with a valid session', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  for (const path of [`/admin/leads?token=${TOKEN}`, `/admin/${TOKEN}/leads`, '/admin/leads?token=anything']) {
    const res = await s.request(path, { headers: { cookie } });
    assert.equal(res.status, 400, path);
  }
});

test('a forged or expired cookie is refused', async (t) => {
  const s = await setup();
  t.after(s.close);
  const forged = `${COOKIE}=99999999999999.${'A'.repeat(43)}`;
  assert.equal((await s.request('/admin/leads', { headers: { cookie: forged } })).status, 303);

  const cookie = await login(s.request);
  const later = await setup({ now: () => new Date(NOW.getTime() + 13 * 3600 * 1000) });
  t.after(later.close);
  assert.equal((await later.request('/admin/leads', { headers: { cookie } })).status, 303, 'expired after 12 hours');
});

test('a Bearer token in the header works for scripts', async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await s.request('/admin/leads', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await s.request('/admin/leads', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('F-01/F-21: values from the database are shown as text, never as markup', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  for (const path of ['/admin/leads/972500000001', '/admin/trials/trial-1', '/admin/recommendations/trial-1%3A1']) {
    const res = await s.request(path, { headers: { cookie } });
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.ok(!body.includes('<script>'), `${path} contains raw <script>`);
    assert.ok(body.includes('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;'), path);
  }
});

test('pages send a strict Content-Security-Policy and no-store', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  const res = await s.request('/admin/leads', { headers: { cookie } });
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('lead board: lists leads, marks those needing action, filters by status', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  const all = await (await s.request('/admin/leads', { headers: { cookie } })).text();
  assert.match(all, /2 לידים/);
  assert.match(all, /class="action"/);
  const closed = await (await s.request('/admin/leads?status=%20closed%20', { headers: { cookie } })).text();
  assert.match(closed, /1 לידים/);
  assert.ok(closed.includes('972500000002') && !closed.includes('/admin/leads/972500000001'));
});

test('lead page: transcript and the stored customer image are shown', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  const body = await (await s.request('/admin/leads/972500000001', { headers: { cookie } })).text();
  assert.match(body, /<img src="\/admin\/media\/972500000001%3A2"/);
  assert.match(body, /27\/10\/2026/);
});

test('F-05: status change is POST only and needs the CSRF field', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);

  assert.equal((await s.request('/admin/leads/972500000001/status?status=closed', { headers: { cookie } })).status, 404, 'GET changes nothing');
  assert.equal((await postForm(s.request, '/admin/leads/972500000001/status', cookie, { status: 'closed' })).status, 403, 'no CSRF');
  assert.equal((await s.storage.get('conversations', '972500000001')).status, 'new');

  const csrf = await csrfFrom(s.request, cookie, '/admin/leads/972500000001');
  assert.equal((await postForm(s.request, '/admin/leads/972500000001/status', cookie, { status: 'unknown', csrf })).status, 400);
  const res = await postForm(s.request, '/admin/leads/972500000001/status', cookie, { status: 'in_progress', csrf });
  assert.equal(res.status, 303);
  const lead = await s.storage.get('conversations', '972500000001');
  assert.equal(lead.status, 'in_progress');
  assert.equal(lead.fullName, XSS, 'other fields kept');
  assert.equal(lead.statusChangedAt, NOW.toISOString());
});

test('recommendations: the owner approves on the dashboard; a second decision is refused', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  const csrf = await csrfFrom(s.request, cookie, '/admin/recommendations/trial-1%3A1');
  const res = await postForm(s.request, '/admin/recommendations/trial-1%3A1/decision', cookie, { decision: 'approved', csrf });
  assert.equal(res.status, 303);
  assert.deepEqual(s.decisions, [{ id: 'trial-1:1', decision: 'approved', decidedBy: 'admin' }]);
  const page = await (await s.request('/admin/recommendations/trial-1%3A1', { headers: { cookie } })).text();
  assert.ok(!page.includes('name="decision"'), 'no form after a decision');
  assert.equal((await postForm(s.request, '/admin/recommendations/trial-1%3A1/decision', cookie, { decision: 'maybe', csrf })).status, 400);
});

test('media: images are served inline; other types only as a download', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  const img = await s.request('/admin/media/972500000001%3A2', { headers: { cookie } });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('content-disposition'), 'inline');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString(), 'PNGDATA');
  const evil = await s.request('/admin/media/evil%3A1', { headers: { cookie } });
  assert.equal(evil.headers.get('content-type'), 'application/octet-stream');
  assert.equal(evil.headers.get('content-disposition'), 'attachment');
  assert.equal((await s.request('/admin/media/972500000001%3A2')).status, 303, 'media needs a session');
});

test('logout clears the cookie', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  const csrf = await csrfFrom(s.request, cookie, '/admin/leads');
  const res = await postForm(s.request, '/admin/logout', cookie, { csrf });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

test('unknown pages are 404; other methods are 405', async (t) => {
  const s = await setup();
  t.after(s.close);
  const cookie = await login(s.request);
  assert.equal((await s.request('/admin/nothing', { headers: { cookie } })).status, 404);
  assert.equal((await s.request('/admin/leads/nobody', { headers: { cookie } })).status, 404);
  assert.equal((await s.request('/admin/leads', { method: 'DELETE', headers: { cookie } })).status, 405);
});

// ---- base 1.1.0: outbound pages (decisions.md items 46 to 51) ----

const { createOutbound } = require('../src/outbound');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { parseMultipart } = require('../src/admin');

async function setupOutbound() {
  const whatsapp = createFakeWhatsAppClient();
  const storageRef = createMemoryStorage({ projectId: 'test-admin-outbound' });
  const outbound = createOutbound({
    storage: storageRef,
    whatsapp,
    isWithinSendWindow: () => true,
    now: () => NOW,
    optOutReplyText: 'הוסרת.',
    signup: { template: { name: 'signup_link', language: 'he', params: ['{name}'] }, link: 'https://example.com/join' },
    templates: { travel: { name: 'travel_offer', language: 'he', label: `הצעה ${XSS}` } },
    fallbacks: { name: 'לקוח' },
    log: { info() {}, error() {} },
  });
  const admin = createAdmin({ adminToken: TOKEN, storage: storageRef, statuses: ['new'], outbound, now: () => NOW, secureCookie: false, log: { info() {}, error() {} } });
  const server = http.createServer((req, res) => admin.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  return { storage: storageRef, whatsapp, outbound, request, close: () => new Promise((r) => server.close(r)) };
}

test('outbound page: signup link sent from the dashboard; CSRF required; nav shows the page', async (t) => {
  const app = await setupOutbound();
  t.after(app.close);
  const cookie = await login(app.request);
  const page = await (await app.request('/admin/outbound', { headers: { cookie } })).text();
  assert.ok(page.includes('href="/admin/outbound"'));
  assert.ok(!page.includes('<script'));
  const noCsrf = await postForm(app.request, '/admin/outbound/signup', cookie, { phone: '0501234567' });
  assert.equal(noCsrf.status, 403);
  const csrf = await csrfFrom(app.request, cookie, '/admin/outbound');
  const res = await postForm(app.request, '/admin/outbound/signup', cookie, { phone: '050-1234567', name: 'דנה', csrf });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/outbound?signup=sent');
  assert.equal(app.whatsapp.sent[0].to, '972501234567');
  const after = await (await app.request(res.headers.get('location'), { headers: { cookie } })).text();
  assert.ok(after.includes('הלינק נשלח.'));
  assert.ok(after.includes('972501234567'));
});

test('campaign from the dashboard: create, upload a Windows-1255 CSV file, start, pause, status filter', async (t) => {
  const app = await setupOutbound();
  t.after(app.close);
  const cookie = await login(app.request);
  const csrf = await csrfFrom(app.request, cookie, '/admin/outbound');
  const created = await postForm(app.request, '/admin/campaigns', cookie, { name: `נוסעים ${XSS}`, templateKey: 'travel', csrf });
  assert.equal(created.status, 303);
  const path = created.headers.get('location');
  const id = decodeURIComponent(path.split('/').pop());

  // "דנה,0501234567" + "x,123" + "0527654321" in Windows-1255, as Hebrew Excel saves CSV.
  const file = Buffer.concat([Buffer.from([0xe3, 0xf0, 0xe4]), Buffer.from(',0501234567\r\nx,123\r\n0527654321\r\n')]);
  const form = new FormData();
  form.append('csrf', csrf);
  form.append('file', new Blob([file], { type: 'text/csv' }), 'list.csv');
  form.append('list', '0501234567\n0531112222');
  const upload = await app.request(`${path}/recipients`, { method: 'POST', headers: { cookie }, body: form });
  assert.equal(upload.status, 303);
  assert.match(upload.headers.get('location'), /added=3&dup=1&invalid=1$/);
  const list = await app.outbound.listRecipients(id);
  assert.deepEqual(list.map((r) => [r.data.phone, r.data.name]), [['972501234567', 'דנה'], ['972527654321', ''], ['972531112222', '']]);

  const page = await (await app.request(upload.headers.get('location'), { headers: { cookie } })).text();
  assert.ok(!page.includes('<script'));
  assert.ok(page.includes('נוספו 3 נמענים'));
  assert.ok(page.includes('ממתין: 3'));

  const start = await postForm(app.request, `${path}/status`, cookie, { action: 'start', csrf });
  assert.equal(start.status, 303);
  assert.equal((await app.outbound.getCampaign(id)).status, 'running');
  await postForm(app.request, `${path}/status`, cookie, { action: 'pause', csrf });
  assert.equal((await app.outbound.getCampaign(id)).status, 'paused');
  const bad = await postForm(app.request, `${path}/status`, cookie, { action: 'pause', csrf });
  assert.equal(bad.status, 400);
  assert.ok((await bad.text()).includes('הקמפיין לא רץ'));

  const filtered = await (await app.request(`${path}?status=failed`, { headers: { cookie } })).text();
  assert.ok(!filtered.includes('972501234567'));

  // The agent sees who answered and what, with a link to the conversation.
  await app.outbound.setStatus(id, 'start');
  await app.outbound.runCampaigns();
  await app.outbound.recordReply({ phone: '972527654321', text: `מעוניין ${XSS}` });
  await app.storage.set('conversations', '972527654321', { customerPhone: '972527654321', status: 'new', campaignName: 'נוסעים' });
  const replied = await (await app.request(`${path}?status=replied`, { headers: { cookie } })).text();
  assert.ok(replied.includes('ענה: 1'));
  assert.ok(replied.includes('href="/admin/leads/972527654321"'));
  assert.ok(replied.includes('מעוניין &lt;script&gt;'));
  assert.ok(!replied.includes('972531112222'));
  const board = await (await app.request('/admin/leads', { headers: { cookie } })).text();
  assert.ok(board.includes('<th>קמפיין</th>') && board.includes('נוסעים'));
});

test('upload: a multipart form is accepted only on the upload route, within 2 MB; empty upload is a clear error', async (t) => {
  const app = await setupOutbound();
  t.after(app.close);
  const cookie = await login(app.request);
  const csrf = await csrfFrom(app.request, cookie, '/admin/outbound');
  const id = await app.outbound.createCampaign({ name: 'x', templateKey: 'travel' });
  const empty = new FormData();
  empty.append('csrf', csrf);
  const res = await app.request(`/admin/campaigns/${id}/recipients`, { method: 'POST', headers: { cookie }, body: empty });
  assert.equal(res.status, 400);
  assert.ok((await res.text()).includes('לא נבחר קובץ'));
  const elsewhere = new FormData();
  elsewhere.append('csrf', csrf);
  elsewhere.append('phone', '0501234567');
  assert.equal((await app.request('/admin/outbound/signup', { method: 'POST', headers: { cookie }, body: elsewhere })).status, 415);
  const big = new FormData();
  big.append('csrf', csrf);
  big.append('list', 'x'.repeat(2 * 1024 * 1024 + 10));
  assert.equal((await app.request(`/admin/campaigns/${id}/recipients`, { method: 'POST', headers: { cookie }, body: big })).status, 413);
});

test('daily limit and opt-out list on the dashboard', async (t) => {
  const app = await setupOutbound();
  t.after(app.close);
  const cookie = await login(app.request);
  const csrf = await csrfFrom(app.request, cookie, '/admin/outbound');
  const saved = await postForm(app.request, '/admin/outbound/ramp', cookie, { startPerDay: '80', stepPerWeek: '40', maxPerDay: '', csrf });
  assert.equal(saved.status, 303);
  assert.deepEqual((await app.outbound.getRamp()).maxPerDay, null);
  const wrong = await postForm(app.request, '/admin/outbound/ramp', cookie, { startPerDay: 'abc', stepPerWeek: '40', maxPerDay: '', csrf });
  assert.equal(wrong.status, 400);
  const add = await postForm(app.request, '/admin/optouts', cookie, { phone: '0501234567', csrf });
  assert.equal(add.status, 303);
  assert.equal(await app.outbound.isOptedOut('972501234567'), true);
  const page = await (await app.request('/admin/optouts', { headers: { cookie } })).text();
  assert.ok(page.includes('972501234567') && page.includes('נוסף בלוח'));
});

test('parseMultipart: fields as text, files as bytes, a field named _files is ignored', () => {
  const b = 'XyZ';
  const body = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\nabc\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="_files"\r\n\r\nevil\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\n050,1\r\n\r\n` +
      `--${b}--\r\n`
  );
  const { fields, files } = parseMultipart(body, b);
  assert.deepEqual(fields, { csrf: 'abc' });
  assert.equal(files.file.toString(), '050,1\r\n');
});

test('without an outbound module the outbound routes do not exist', async (t) => {
  const app = await setup();
  t.after(app.close);
  const cookie = await login(app.request);
  assert.equal((await app.request('/admin/outbound', { headers: { cookie } })).status, 404);
  const page = await (await app.request('/admin/leads', { headers: { cookie } })).text();
  assert.ok(!page.includes('/admin/outbound'));
});
