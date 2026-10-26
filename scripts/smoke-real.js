'use strict';

// Real test environment check (stage 2, decisions.md item 14): the separate test
// Firestore project and the test WhatsApp number. Run only on purpose, by the
// manual GitHub Actions workflow "smoke-real" (the secrets live in GitHub, never
// in the repo or the chat).
//
// 1. Firestore: write one record to the test project, read it back, delete it.
// 2. WhatsApp: send ONE template message to the test recipient only, and only inside
//    the send window (Sunday to Thursday, 09:00 to 17:50 Israel time). A template is
//    used because a free text needs an open 24-hour conversation (Meta rule).
// 3. Email (only when the SendGrid variables are set): one email to NOTIFY_EMAIL.
//
// Each part whose variables are missing is reported "not run", never "passed".
// Logs never print a token, a key or a phone number.
//
// Variables:
//   FIRESTORE_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS_JSON (service account key, JSON text)
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, SMOKE_TEST_TO (test recipient),
//   SMOKE_TEMPLATE (default hello_world), SMOKE_TEMPLATE_LANGUAGE (default en_US)
//   SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, NOTIFY_EMAIL (optional)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..', 'src');
const { createStorage } = require(root + '/storage');
const { createWhatsAppClient } = require(root + '/whatsapp');
const { createEmailClient, notifyEmail } = require(root + '/email');
const { isWithinSendWindow } = require(root + '/schedule-window');

const env = process.env;
const has = (...names) => names.every((n) => typeof env[n] === 'string' && env[n].trim() !== '');

async function firestorePart() {
  if (!has('FIRESTORE_PROJECT_ID', 'GOOGLE_APPLICATION_CREDENTIALS_JSON')) return ['not run', 'FIRESTORE_PROJECT_ID or GOOGLE_APPLICATION_CREDENTIALS_JSON not set'];
  if (env.FIRESTORE_EMULATOR_HOST) return ['FAIL', 'FIRESTORE_EMULATOR_HOST is set; this check must reach the real test project'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  const keyFile = path.join(dir, 'key.json');
  fs.writeFileSync(keyFile, env.GOOGLE_APPLICATION_CREDENTIALS_JSON, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
  try {
    const storage = createStorage({ projectId: env.FIRESTORE_PROJECT_ID });
    const id = `smoke-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    await storage.set('smoke_checks', id, { at: new Date().toISOString(), source: 'smoke-real' });
    const back = await storage.get('smoke_checks', id);
    await storage.delete('smoke_checks', id);
    const gone = (await storage.get('smoke_checks', id)) === null;
    return back && gone ? ['PASS', 'write, read back and delete on the test project'] : ['FAIL', 'record not read back or not deleted'];
  } catch (err) {
    return ['FAIL', `${err.name}: ${err.message}`];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function whatsappPart() {
  if (!has('WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'SMOKE_TEST_TO')) return ['not run', 'WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID or SMOKE_TEST_TO not set'];
  if (!isWithinSendWindow(new Date(), { holidays: [] })) return ['not run', 'outside the send window (Sun-Thu 09:00-17:50 Israel time); nothing sent'];
  try {
    const client = createWhatsAppClient({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID });
    const { messageId } = await client.sendTemplate({
      to: env.SMOKE_TEST_TO,
      templateName: env.SMOKE_TEMPLATE || 'hello_world',
      language: env.SMOKE_TEMPLATE_LANGUAGE || 'en_US',
    });
    return ['PASS', `one template message accepted by WhatsApp (message ID ${messageId.slice(0, 12)}...)`];
  } catch (err) {
    return ['FAIL', `${err.name}: ${err.message}${err.code ? ` (code ${err.code})` : ''}`];
  }
}

async function emailPart() {
  if (!has('SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL', 'NOTIFY_EMAIL')) return ['not run', 'SendGrid variables not set'];
  try {
    const client = createEmailClient({ apiKey: env.SENDGRID_API_KEY, from: env.SENDGRID_FROM_EMAIL });
    await client.send(notifyEmail({ to: env.NOTIFY_EMAIL, subject: 'בדיקת סביבת בדיקה: מייל', text: `בדיקת חיבור אמיתית מהבסיס. ${new Date().toISOString()}` }));
    return ['PASS', 'one email accepted by SendGrid'];
  } catch (err) {
    return ['FAIL', `${err.name}: ${err.message}`];
  }
}

(async () => {
  const results = [
    ['Firestore (test project)', await firestorePart()],
    ['WhatsApp (test number)', await whatsappPart()],
    ['Email (SendGrid)', await emailPart()],
  ];
  console.log('| Check | Result | Detail |');
  console.log('|---|---|---|');
  for (const [name, [result, detail]] of results) console.log(`| ${name} | ${result} | ${detail} |`);
  const failed = results.some(([, [r]]) => r === 'FAIL');
  const ran = results.filter(([, [r]]) => r === 'PASS').length;
  console.log(failed ? 'SMOKE FAIL' : ran === 0 ? 'SMOKE NOT RUN (no secrets set)' : 'SMOKE PASS');
  process.exitCode = failed ? 1 : 0;
})();
