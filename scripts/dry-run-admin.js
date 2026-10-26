'use strict';

// Dry run for B11 admin dashboard (stage 2, S2-2). Nothing is sent, nothing real is touched.
// Starts the dashboard on a local port over in-memory storage with sample leads
// (one with a hostile name), logs in like a browser, opens every page, changes a
// status and decides a recommendation, then checks the results.
// Pass --keep to leave the server running (for screenshots). Exit code 1 on failure.

const http = require('node:http');
const { createAdmin } = require('../src/admin');
const { createMemoryStorage } = require('../src/fakes/memory-storage');

const TOKEN = 'dry-run-admin-token-000';
const ATTACK = `<script>alert('x')</script>`;

async function seed(storage) {
  const leads = [
    ['972500000001', { status: 'new', fullName: 'דנה כהן', callbackDate: '27/10/2026', agent_action_required: true, lastMessageAt: '2026-10-26T09:05:00Z' }],
    ['972500000002', { status: 'in_progress', fullName: ATTACK, callbackDate: '28/10/2026', agent_action_required: false, lastMessageAt: '2026-10-26T08:00:00Z' }],
    ['972500000003', { status: 'closed', fullName: 'יוסי לוי', agent_action_required: false, lastMessageAt: '2026-10-25T12:00:00Z' }],
  ];
  for (const [id, data] of leads) await storage.set('conversations', id, { customerPhone: id, ...data });
  const msgs = [
    ['user', 'שלום, אני צריכה ביטוח נסיעות לחו"ל'],
    ['assistant', 'בשמחה! לאן ומתי אתם נוסעים?'],
    ['user', `ליוון, 3/11 עד 10/11 ${ATTACK}`],
    ['assistant', 'תודה! נציג יחזור אליך מחר.'],
  ];
  let seq = 0;
  for (const [role, text] of msgs) {
    seq += 1;
    await storage.set('messages', `972500000001:${seq}`, { conversationId: '972500000001', seq, role, kind: 'text', text, at: `2026-10-26T09:0${seq}:00Z` });
  }
  await storage.set('test_sessions', 'trial-1', { status: 'closed', answerCount: 2, endedAt: '2026-10-26T07:00:00Z' });
  await storage.set('improvements', 'trial-1:1', { trialId: 'trial-1', question: 'מה היה חסר בשיחה?', answer: 'הבוט לא שאל על גילאים' });
  await storage.set('improvements', 'trial-1:2', { trialId: 'trial-1', question: 'מה לשנות בניסוח?', answer: ATTACK });
  await storage.set('recommendations', 'trial-1:1', {
    trialId: 'trial-1', summary: 'לשאול על גילאי הנוסעים', change: 'Add: ask the age of every traveller before quoting.', reason: 'Feedback note 1', status: 'pending_approval',
  });
}

async function main() {
  const keep = process.argv.includes('--keep');
  const storage = createMemoryStorage({ projectId: 'dry-run' });
  await seed(storage);
  const decisions = [];
  const admin = createAdmin({
    adminToken: TOKEN,
    storage,
    statuses: ['new', 'in_progress', 'closed'],
    botName: 'בוט בדיקה',
    secureCookie: false, // plain http on localhost only
    testMode: {
      async decideRecommendation({ id, decision, decidedBy }) {
        decisions.push(decision);
        const rec = await storage.get('recommendations', id);
        await storage.set('recommendations', id, { ...rec, status: decision, decidedAt: new Date().toISOString(), decidedBy });
      },
    },
    log: { info: (m) => console.log('log:', m), error: (m) => console.log('log:', m) },
  });
  const server = http.createServer((req, res) => admin.handle(req, res));
  await new Promise((r) => server.listen(Number(process.env.PORT) || 0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const form = (fields) => ({ 'Content-Type': 'application/x-www-form-urlencoded', body: new URLSearchParams(fields).toString() });

  const checks = [];
  const check = (name, pass) => checks.push([name, Boolean(pass)]);

  check('no session -> login page', (await req('/admin/leads')).headers.get('location') === '/admin/login');
  check('token in URL refused', (await req(`/admin/leads?token=${TOKEN}`)).status === 400);
  const bad = await req('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=wrong' });
  check('wrong login refused', bad.status === 401);
  const ok = await req('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: TOKEN }).toString() });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  check('login sets HttpOnly SameSite=Strict cookie', /HttpOnly/.test(ok.headers.get('set-cookie')) && /SameSite=Strict/.test(ok.headers.get('set-cookie')));

  const pages = ['/admin/leads', '/admin/leads/972500000001', '/admin/leads/972500000002', '/admin/trials', '/admin/trials/trial-1', '/admin/recommendations/trial-1%3A1'];
  let csrf = '';
  for (const p of pages) {
    const res = await req(p, { headers: { cookie } });
    const body = await res.text();
    check(`${p}: 200, no raw <script>`, res.status === 200 && !body.includes('<script>'));
    csrf = csrf || (/name="csrf" value="([^"]+)"/.exec(body) || [])[1];
  }
  const { body: b1, ...h1 } = form({ status: 'in_progress', csrf });
  check('status change without CSRF refused', (await req('/admin/leads/972500000003/status', { method: 'POST', headers: { cookie, ...h1 }, body: new URLSearchParams({ status: 'new' }).toString() })).status === 403);
  check('status change with CSRF saved', (await req('/admin/leads/972500000003/status', { method: 'POST', headers: { cookie, ...h1 }, body: b1 })).status === 303 && (await storage.get('conversations', '972500000003')).status === 'in_progress');
  const { body: b2, ...h2 } = form({ decision: 'approved', csrf });
  await req('/admin/recommendations/trial-1%3A1/decision', { method: 'POST', headers: { cookie, ...h2 }, body: b2 });
  check('recommendation approved by owner', decisions.join() === 'approved');

  console.log('--- checks ---');
  let pass = true;
  for (const [name, p] of checks) {
    console.log(`${p ? 'PASS' : 'FAIL'} ${name}`);
    if (!p) pass = false;
  }
  console.log(pass ? 'DRY RUN PASS (nothing was sent)' : 'DRY RUN FAIL');
  process.exitCode = pass ? 0 : 1;
  if (keep) {
    console.log(`dashboard at ${base}/admin/login (token: ${TOKEN})`);
  } else {
    server.close();
  }
}

main().catch((err) => {
  console.error('DRY RUN ERROR', err);
  process.exitCode = 1;
});
