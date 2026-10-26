'use strict';

// T-09 DRY RUN: the full flow runs, nothing real is sent, and every message that
// would have been sent is logged (test-plan.md).
//
// Real modules end to end: config, HTTP server, signature check, WhatsApp client,
// conversation engine, AI client, send window, storage, test mode, email client,
// admin dashboard, scheduled job lock, health check. Only the network is replaced:
// every outgoing HTTP call (WhatsApp, Anthropic, SendGrid) goes to a recording fetch.
//
// Storage: Firestore on the emulator when FIRESTORE_EMULATOR_HOST is set (a fresh
// project ID per run), otherwise the in-memory fake. The report says which.
//
// Run: node scripts/dry-run.js        Exit code 1 if any check fails.
// The test file test/integration.test.js runs the same function (T-09).

const crypto = require('node:crypto');
const root = require('node:path').join(__dirname, '..', 'src');
const { createBot } = require(root + '/index');
const { REQUIRED_ENV } = require(root + '/config');
const { createWhatsAppClient } = require(root + '/whatsapp');
const { createAiClient } = require(root + '/ai');
const { createEmailClient } = require(root + '/email');
const { createStorage } = require(root + '/storage');
const { createMemoryStorage } = require(root + '/fakes/memory-storage');
const { createJobRunner } = require(root + '/jobs');
const { checkHealth } = require(root + '/health');
const { isWithinSendWindow } = require(root + '/schedule-window');

const CUSTOMER = '972500000001';
const TESTER = '972500000099';
const OWNER_PHONE = '972500000098';
const AGENT_PHONE = '972500000077';
const ATTACK = `<script>alert('x')</script>`;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * @param {{storage?: import('../src/storage').Storage, log?: (line: string) => void}} [options]
 * @returns {Promise<{ok: boolean, storageKind: string, checks: Array<[string, boolean]>, wouldSend: object[]}>}
 */
async function runDryRun(options = {}) {
  const print = options.log || (() => {});
  const projectId = `dry-run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const storageKind = options.storage ? 'injected' : process.env.FIRESTORE_EMULATOR_HOST ? 'firestore-emulator' : 'memory';
  const storage = options.storage || (storageKind === 'firestore-emulator' ? createStorage({ projectId }) : createMemoryStorage({ projectId }));

  const env = Object.fromEntries(REQUIRED_ENV.map((n) => [n, `dry-run-${n.toLowerCase()}`]));
  Object.assign(env, {
    APP_BASE_URL: 'https://bot.example.com',
    FIRESTORE_PROJECT_ID: projectId,
    SENDGRID_API_KEY: 'dry-run-sendgrid',
    SENDGRID_FROM_EMAIL: 'bot@example.com',
    NOTIFY_EMAIL: 'agent@example.com',
    HEALTH_CHECK_PHONE: OWNER_PHONE,
    HEALTH_CHECK_ALERT_PHONE: OWNER_PHONE,
    // Dedi, 2026-10-26: email by default; WhatsApp to the agent for these events.
    AGENT_WHATSAPP_PHONE: AGENT_PHONE,
    AGENT_WHATSAPP_EVENTS: 'handoff,daily_summary',
  });

  // ---- recording network ----
  const wouldSend = [];
  let outId = 0;
  const whatsappFetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') {
      // Media download: metadata, then the file.
      if (url.startsWith('https://media.example/')) return { ok: true, status: 200, arrayBuffer: async () => PNG };
      return { ok: true, status: 200, json: async () => ({ url: `https://media.example/${outId}`, mime_type: 'image/png' }) };
    }
    const body = JSON.parse(init.body);
    outId += 1;
    wouldSend.push({ channel: 'whatsapp', to: body.to, text: body.text ? body.text.body : body.type });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `dry-out-${outId}` }] }) };
  };

  const aiQueue = [];
  const aiRequests = [];
  const aiFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    aiRequests.push(body);
    const input = aiQueue.shift();
    if (!input) throw new Error('dry run: no queued AI reply');
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: body.tool_choice.name, input }] }) };
  };

  const emailFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    wouldSend.push({ channel: 'email', to: body.personalizations[0].to[0].email, text: body.subject, html: body.content[1].value, plain: body.content[0].value });
    return { ok: true, status: 202 };
  };

  // Monday 26 Oct 2026, 12:00 Israel time: inside the send window.
  let clock = new Date('2026-10-26T10:00:00Z');
  const now = () => clock;

  const whatsapp = createWhatsAppClient({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, fetch: whatsappFetch });
  const ai = createAiClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL, fetch: aiFetch });
  const email = createEmailClient({ apiKey: env.SENDGRID_API_KEY, from: env.SENDGRID_FROM_EMAIL, fetch: emailFetch });
  const jobs = createJobRunner({ storage, now });

  const bot = createBot({
    env,
    storage,
    whatsapp,
    ai,
    email,
    now,
    botName: 'בוט בדיקה',
    systemPrompt: 'Dry run system prompt.',
    tool: {
      name: 'send_whatsapp_reply',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' }, handoff: { type: 'boolean' }, handoff_reason: { type: 'string' } },
      },
    },
    unsupportedReplyText: 'מצטער, אני קורא רק הודעות טקסט.',
    acceptedMediaTypes: ['image', 'document'],
    mediaReceivedReplyText: 'תודה, קיבלנו את הקובץ',
    mediaRejectedReplyText: 'אני מקבל קבצים רק בפורמט: {accepted}',
    mediaTypeLabels: { image: 'תמונה', document: 'מסמך' },
    testMode: {
      phones: [TESTER],
      endKeyword: 'סיום בדיקה',
      questions: ['מה היה טוב?', 'מה היה חסר?', 'מה לשנות בניסוח?', 'עוד משהו?'],
      closingText: 'תודה! ההערות נשמרו.',
    },
    jobs: {
      'send-reminders': async () => {
        const key = now().toISOString().slice(0, 10);
        return jobs.runOnce('send-reminders', key, async () => {
          for (const lead of await jobs.findDueReminders({ collection: 'conversations', today: now() })) {
            if (isWithinSendWindow(now(), { holidays: [] })) await whatsapp.sendText({ to: lead.id, text: 'תזכורת: נציג יחזור אליך היום.' });
          }
        });
      },
    },
    log: { info() {}, error: (m) => print(`log: ${m}`) },
  });

  bot.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => bot.server.once('listening', resolve));
  const base = `http://127.0.0.1:${bot.server.address().port}`;
  const checks = [];
  const check = (name, pass) => {
    checks.push([name, Boolean(pass)]);
    print(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  };

  let msgId = 0;
  const deliver = async (from, message, { badSignature = false } = {}) => {
    msgId += 1;
    const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.dry.${msgId}`, from, ...message }] } }] }] }));
    const sig = 'sha256=' + crypto.createHmac('sha256', badSignature ? 'wrong-secret' : env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
    const res = await fetch(`${base}/whatsapp-webhook`, { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sig } });
    const out = await res.json();
    return { status: res.status, results: out.results || [], id: `wamid.dry.${msgId}`, raw, sig };
  };
  const text = (body) => ({ type: 'text', text: { body } });
  const sentSince = (n) => wouldSend.slice(n);

  try {
    // 1. Webhook registration
    const reg = await fetch(`${base}/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=42`);
    check('webhook registration answers the challenge', reg.status === 200 && (await reg.text()) === '42');

    // 2. Customer text -> AI reply
    let mark = wouldSend.length;
    aiQueue.push({ text: 'שלום! לאן אתם נוסעים?' });
    const r1 = await deliver(CUSTOMER, text('שלום, אני צריכה ביטוח נסיעות'));
    check('customer text gets one AI reply', r1.results[0] === 'replied' && sentSince(mark).length === 1);

    // 3. Same message again (Meta retry) -> processed once (T-03)
    mark = wouldSend.length;
    const dup = await fetch(`${base}/whatsapp-webhook`, { method: 'POST', body: r1.raw, headers: { 'X-Hub-Signature-256': r1.sig } });
    check('T-03 duplicate message is processed once', (await dup.json()).results[0] === 'duplicate' && sentSince(mark).length === 0);

    // 4. Customer sends an ID photo -> stored and acknowledged
    mark = wouldSend.length;
    const img = await deliver(CUSTOMER, { type: 'image', image: { id: 'media-1', mime_type: 'image/png' } });
    const stored = (await storage.list('media')).find((m) => m.id.startsWith(`${CUSTOMER}:`));
    check('accepted image is stored in the database and acknowledged', img.results[0] === 'media_received' && stored && stored.data.stored === true && sentSince(mark).length === 1);

    // 5. Voice note -> defined reply (T-17)
    mark = wouldSend.length;
    const voice = await deliver(CUSTOMER, { type: 'audio', audio: { id: 'media-2', mime_type: 'audio/ogg' } });
    check('T-17 a non-accepted format gets the accepted-formats reply', voice.results[0] === 'media_rejected' && /תמונה, מסמך/.test(sentSince(mark)[0].text));

    // 6. Handoff -> thank the customer, record, email the agent (B10)
    mark = wouldSend.length;
    aiQueue.push({ text: 'תודה! נציג יחזור אליך.', handoff: true, handoff_reason: `price question ${ATTACK}` });
    const h = await deliver(CUSTOMER, text('כמה זה עולה?'));
    const handoffMail = sentSince(mark).find((s) => s.channel === 'email');
    const agentMsg = sentSince(mark).find((s) => s.channel === 'whatsapp' && s.to === AGENT_PHONE);
    check('handoff: customer reply first, then email to the agent', h.results[0] === 'handoff' && sentSince(mark)[0].to === CUSTOMER && handoffMail && handoffMail.to === 'agent@example.com');
    check('handoff: WhatsApp message to the agent (listed event)', agentMsg && agentMsg.text.includes(CUSTOMER) && agentMsg.text.includes('/admin/leads/'));
    check('F-22 handoff email escapes the reason and has no token', handoffMail && !handoffMail.html.includes('<script') && !handoffMail.html.includes('token'));
    check('handoff recorded on the lead', (await storage.get('conversations', CUSTOMER)).agent_action_required === true);

    // 7. Forged signature -> 401 (T-02)
    const forged = await deliver(CUSTOMER, text('forged'), { badSignature: true });
    check('T-02 forged signature is rejected', forged.status === 401);

    // 8. Friday -> outside the window, saved, nothing sent (T-04)
    clock = new Date('2026-10-30T10:00:00Z');
    mark = wouldSend.length;
    const fri = await deliver(CUSTOMER, text('שאלה ביום שישי'));
    check('T-04 outside the send window: saved, nothing sent', fri.results[0] === 'outside_window' && sentSince(mark).length === 0);
    clock = new Date('2026-10-26T11:00:00Z');

    // 9. Test mode (T-10): tester chats, ends the trial, answers 4 questions with a screenshot
    mark = wouldSend.length;
    aiQueue.push({ text: 'שלום! אני הבוט.' });
    await deliver(TESTER, text('היי, זו בדיקה'));
    const end = await deliver(TESTER, text('סיום בדיקה'));
    check('T-10 end keyword ends the trial and sends question 1', end.results[0] === 'test_trial_ended' && sentSince(mark).at(-1).text === 'מה היה טוב?');
    await deliver(TESTER, text('התשובות ברורות'));
    await deliver(TESTER, { type: 'image', image: { id: 'shot-1', mime_type: 'image/png', caption: 'צילום מסך' } });
    await deliver(TESTER, text('לא שאל על גילאים'));
    await deliver(TESTER, text(`ניסוח קצר יותר ${ATTACK}`));
    aiQueue.push({ recommendations: [{ summary: 'לשאול על גילאי הנוסעים', change: 'Ask every traveller age.', reason: 'Tester note 2' }] });
    mark = wouldSend.length;
    const last = await deliver(TESTER, text('זהו'));
    const trialId = (await storage.get('conversations', TESTER)).lastTrialId;
    const notes = trialId ? await bot.testMode.listImprovements(trialId) : [];
    const recs = trialId ? await bot.testMode.listRecommendations(trialId) : [];
    check('T-10 4 answers + screenshot saved, closing text sent', last.results[0] === 'test_feedback' && notes.length === 5 && sentSince(mark).some((s) => s.text === 'תודה! ההערות נשמרו.'));
    const recMail = sentSince(mark).find((s) => s.channel === 'email');
    check('recommendation saved as pending and emailed to the owner with a dashboard link', recs.length === 1 && recs[0].data.status === 'pending_approval' && recMail && recMail.plain.includes('https://bot.example.com/admin/recommendations/'));
    check('recommendation is not sent to the agent by WhatsApp (not a listed event)', !sentSince(mark).some((s) => s.to === AGENT_PHONE));

    // 10. Dashboard (B11): login, lead with image, approve the recommendation
    const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: env.ADMIN_TOKEN }).toString() });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('dashboard login sets a session cookie', login.status === 303 && cookie.startsWith('admin_session='));
    const tokenUrl = await fetch(`${base}/admin/leads?token=${env.ADMIN_TOKEN}`, { redirect: 'manual', headers: { cookie } });
    check('T-16 token in the URL is refused', tokenUrl.status === 400);
    const leadPage = await (await fetch(`${base}/admin/leads/${CUSTOMER}`, { headers: { cookie } })).text();
    check('lead page shows the stored image and escapes data', leadPage.includes('<img src="/admin/media/') && !leadPage.includes('<script'));
    const recPage = await (await fetch(`${base}/admin/recommendations/${encodeURIComponent(recs[0].id)}`, { headers: { cookie } })).text();
    const csrf = (/name="csrf" value="([^"]+)"/.exec(recPage) || [])[1];
    await fetch(`${base}/admin/recommendations/${encodeURIComponent(recs[0].id)}/decision`, { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision: 'approved', csrf }).toString() });
    check('owner approves the recommendation on the dashboard', (await storage.get('recommendations', recs[0].id)).status === 'approved');

    // 11. Reminder job, run twice (T-08, T-16 job token in header)
    const lead = await storage.get('conversations', CUSTOMER);
    await storage.set('conversations', CUSTOMER, { ...lead, callbackDate: '26/10/2026' });
    mark = wouldSend.length;
    const runJob = () => fetch(`${base}/jobs/send-reminders`, { method: 'POST', headers: { Authorization: `Bearer ${env.SCHEDULED_JOB_TOKEN}` } }).then((r) => r.json());
    const first = await runJob();
    const second = await runJob();
    check('T-08 two runs of the reminder job send one message', first.result.status === 'ran' && second.result.status === 'already_done' && sentSince(mark).length === 1);

    // 12. Daily summary at 18:15 Israel time (after the 17:50 customer window), run twice
    clock = new Date('2026-10-26T16:15:00Z');
    mark = wouldSend.length;
    const digest = () => fetch(`${base}/jobs/send-daily-digest`, { method: 'POST', headers: { Authorization: `Bearer ${env.SCHEDULED_JOB_TOKEN}` } }).then((r) => r.json());
    const d1 = await digest();
    const d2 = await digest();
    const digestSent = sentSince(mark);
    check('daily summary at 18:15: email + WhatsApp to the agent, once (T-08)', d1.result.status === 'ran' && d2.result.status === 'already_done' && digestSent.length === 2 && digestSent.some((s) => s.channel === 'email') && digestSent.some((s) => s.to === AGENT_PHONE));
    check('daily summary counts the day', d1.result.counts.handoffsToday === 1 && d1.result.counts.waiting === 1);
    clock = new Date('2026-10-26T11:00:00Z');

    // 13. Health check: real result message (recorded), no alert when healthy
    mark = wouldSend.length;
    const health = await checkHealth({ storage, whatsapp, ai, config: bot.config, now });
    check('health check passes and sends its result message', health.ok && sentSince(mark).length === 1 && sentSince(mark)[0].to === OWNER_PHONE);

    check('no AI request was left unanswered', aiQueue.length === 0);
  } finally {
    await new Promise((resolve) => bot.server.close(resolve));
  }

  const ok = checks.every(([, pass]) => pass);
  return { ok, storageKind, checks, wouldSend };
}

if (require.main === module) {
  runDryRun({ log: (line) => console.log(line) })
    .then((report) => {
      console.log(`--- storage: ${report.storageKind} ---`);
      console.log(`--- would have been sent (${report.wouldSend.length}), nothing was sent ---`);
      for (const s of report.wouldSend) console.log(`${s.channel} -> ${s.to}: ${s.text}`);
      console.log(report.ok ? 'T-09 DRY RUN PASS' : 'T-09 DRY RUN FAIL');
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((err) => {
      console.error('T-09 DRY RUN ERROR', err);
      process.exitCode = 1;
    });
}

module.exports = { runDryRun };
