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
