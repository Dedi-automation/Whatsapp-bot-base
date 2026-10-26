'use strict';
// Branch B DRY RUN (run: node scripts/dry-run-branch-b.js): HTTP request -> server -> signature -> parse -> engine -> WhatsApp client.
// The WhatsApp client is real; its fetch only records requests, nothing leaves the machine.
// AI and storage are the step 0 fakes; the send window is a stub (branch D not merged).
const root = require('node:path').join(__dirname, '..', 'src');
const crypto = require('node:crypto');
const { loadConfig, REQUIRED_ENV } = require(root + '/config');
const { verifyWhatsAppSignature, checkBearerToken, createDeduplicator } = require(root + '/security');
const { createWhatsAppClient } = require(root + '/whatsapp');
const { createConversationEngine } = require(root + '/conversation');
const { createServer } = require(root + '/server');
const { createMemoryStorage } = require(root + '/fakes/memory-storage');
const { createFakeAiClient } = require(root + '/fakes/ai-fake');

const config = loadConfig(Object.fromEntries(REQUIRED_ENV.map((n) => [n, `dry-${n}`])));
const wouldSend = [];
let n = 0;
const recordingFetch = async (url, init) => {
  wouldSend.push({ url, body: JSON.parse(init.body) });
  n += 1;
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: `dry-out-${n}` }] }) };
};
const whatsapp = createWhatsAppClient({ token: config.whatsappToken, phoneNumberId: config.whatsappPhoneNumberId, fetch: recordingFetch });
const storage = createMemoryStorage({ projectId: config.firestoreProjectId });
let within = true;
const engine = createConversationEngine({
  storage, whatsapp,
  ai: createFakeAiClient([{ text: 'שלום, איך אפשר לעזור?' }, { text: 'תודה, נציג יחזור אליך בהקדם', handoff: true, handoff_reason: 'price question' }]),
  deduplicator: createDeduplicator({ storage }),
  isWithinSendWindow: () => within,
  now: () => new Date('2026-10-26T09:00:00Z'),
  unsupportedReplyText: 'Sorry, I can only read text messages.',
  // Example bot that needs an ID photo: images and documents are accepted.
  acceptedMediaTypes: ['image', 'document'],
  mediaReceivedReplyText: 'תודה, קיבלנו את הקובץ',
  systemPrompt: 'dry-run system prompt',
  tool: { name: 'send_whatsapp_reply', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, handoff: { type: 'boolean' } } } },
});

const webhook = (messages) => {
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages } }] }] }));
  const sig = 'sha256=' + crypto.createHmac('sha256', config.whatsappAppSecret).update(raw).digest('hex');
  return { raw, sig };
};

const quiet = { info() {}, error() {} };
let base;
async function deliver(label, messages, { badSig = false } = {}) {
  const { raw, sig } = webhook(messages);
  const before = wouldSend.length;
  const res = await fetch(`${base}/whatsapp-webhook`, {
    method: 'POST',
    body: raw,
    headers: { 'X-Hub-Signature-256': badSig ? sig.replace(/.$/, sig.endsWith('0') ? '1' : '0') : sig },
  });
  const out = await res.json();
  console.log(`${label}: HTTP ${res.status} ${out.results ? out.results.join(',') : out.error}, would send ${wouldSend.length - before}`);
}

(async () => {
  let jobRuns = 0;
  const server = createServer({ config, whatsapp, engine, jobs: { 'send-reminders': async () => { jobRuns += 1; return { sent: 0 }; } }, log: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const challenge = await fetch(`${base}/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=${config.whatsappVerifyToken}&hub.challenge=42`);
  console.log(`0 webhook registration: HTTP ${challenge.status} ${await challenge.text()}`);
  const from = '972500000001';
  await deliver('1 text', [{ id: 'w1', from, type: 'text', text: { body: 'היי' } }]);
  await deliver('2 same id again', [{ id: 'w1', from, type: 'text', text: { body: 'היי' } }]);
  await deliver('3 voice note', [{ id: 'w2', from, type: 'audio' }]);
  await deliver('3b ID photo (accepted)', [{ id: 'w2b', from, type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'תעודת זהות' } }]);
  await deliver('3c video (not accepted)', [{ id: 'w2c', from, type: 'video', video: { id: 'media-2', mime_type: 'video/mp4' } }]);
  await deliver('4 forged signature', [{ id: 'w3', from, type: 'text', text: { body: 'x' } }], { badSig: true });
  await deliver('5 handoff', [{ id: 'w4', from, type: 'text', text: { body: 'כמה זה עולה?' } }]);
  within = false;
  await deliver('6 outside window', [{ id: 'w5', from, type: 'text', text: { body: 'עוד שאלה' } }]);
  const jobUrl = `${base}/jobs/send-reminders`;
  const auth = { Authorization: `Bearer ${config.scheduledJobToken}` };
  const inUrl = await fetch(`${jobUrl}?token=${config.scheduledJobToken}`, { method: 'POST', headers: auth });
  const inHeader = await fetch(jobUrl, { method: 'POST', headers: auth });
  console.log(`job token in URL: HTTP ${inUrl.status}; in header: HTTP ${inHeader.status}; job runs: ${jobRuns}`);
  console.log(`health: HTTP ${(await fetch(`${base}/health`)).status}`);
  const shot = (await storage.list('messages')).find((r) => r.data.messageId === 'w2b');
  console.log('ID photo stored as:', JSON.stringify(shot.data.media));
  const conv = await storage.get('conversations', from);
  console.log('conversation:', JSON.stringify({ messageCount: conv.messageCount, agent_action_required: conv.agent_action_required, handoff_reason: conv.handoff_reason }));
  console.log('would have sent:');
  for (const s of wouldSend) console.log('  ', s.url.replace(/^https:\/\/[^/]+/, ''), JSON.stringify(s.body.text));
  server.close();
})();
