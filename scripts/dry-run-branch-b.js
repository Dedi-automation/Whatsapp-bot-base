'use strict';
// Branch B DRY RUN (run: node scripts/dry-run-branch-b.js): webhook body -> signature -> parse -> engine -> WhatsApp client.
// The WhatsApp client is real; its fetch only records requests, nothing leaves the machine.
// AI and storage are the step 0 fakes; the send window is a stub (branch D not merged).
const root = require('node:path').join(__dirname, '..', 'src');
const crypto = require('node:crypto');
const { loadConfig, REQUIRED_ENV } = require(root + '/config');
const { verifyWhatsAppSignature, checkBearerToken, createDeduplicator } = require(root + '/security');
const { createWhatsAppClient } = require(root + '/whatsapp');
const { createConversationEngine } = require(root + '/conversation');
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
  systemPrompt: 'dry-run system prompt',
  tool: { name: 'send_whatsapp_reply', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, handoff: { type: 'boolean' } } } },
});

const webhook = (messages) => {
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages } }] }] }));
  const sig = 'sha256=' + crypto.createHmac('sha256', config.whatsappAppSecret).update(raw).digest('hex');
  return { raw, sig };
};

async function deliver(label, messages, { badSig = false } = {}) {
  const { raw, sig } = webhook(messages);
  const ok = verifyWhatsAppSignature({ rawBody: raw, signatureHeader: badSig ? sig.replace(/.$/, '0') : sig, appSecret: config.whatsappAppSecret });
  if (!ok) return console.log(`${label}: rejected (bad signature)`);
  for (const m of whatsapp.parseIncoming(JSON.parse(raw))) {
    const before = wouldSend.length;
    const out = await engine.handleIncoming(m);
    console.log(`${label}: ${out.status}, would send ${wouldSend.length - before}`);
  }
}

(async () => {
  const from = '972500000001';
  await deliver('1 text', [{ id: 'w1', from, type: 'text', text: { body: 'היי' } }]);
  await deliver('2 same id again', [{ id: 'w1', from, type: 'text', text: { body: 'היי' } }]);
  await deliver('3 voice note', [{ id: 'w2', from, type: 'audio' }]);
  await deliver('4 forged signature', [{ id: 'w3', from, type: 'text', text: { body: 'x' } }], { badSig: true });
  await deliver('5 handoff', [{ id: 'w4', from, type: 'text', text: { body: 'כמה זה עולה?' } }]);
  within = false;
  await deliver('6 outside window', [{ id: 'w5', from, type: 'text', text: { body: 'עוד שאלה' } }]);
  console.log('job token in URL accepted:', checkBearerToken({ url: '/jobs/send-reminders?token=dry-SCHEDULED_JOB_TOKEN', headers: { authorization: 'Bearer dry-SCHEDULED_JOB_TOKEN' }, expected: config.scheduledJobToken }));
  console.log('job token in header accepted:', checkBearerToken({ url: '/jobs/send-reminders', headers: { authorization: 'Bearer dry-SCHEDULED_JOB_TOKEN' }, expected: config.scheduledJobToken }));
  const conv = await storage.get('conversations', from);
  console.log('conversation:', JSON.stringify({ messageCount: conv.messageCount, agent_action_required: conv.agent_action_required, handoff_reason: conv.handoff_reason }));
  console.log('would have sent:');
  for (const s of wouldSend) console.log('  ', s.url.replace(/^https:\/\/[^/]+/, ''), JSON.stringify(s.body.text));
})();
