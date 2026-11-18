'use strict';

// Base entry point (Branch B). A bot repo calls createBot with its own prompt, tool
// and reply texts; the base supplies the wiring. The base itself is never deployed.
//
//   const { createBot } = require('whatsapp-bot-base');
//   const bot = createBot({ systemPrompt, tool, unsupportedReplyText });
//   bot.listen();
//
// Config is loaded first, so a missing variable stops startup before anything
// else is built (T-01, F-14).
//
// Stage 2 wiring: the admin dashboard (B11) is mounted at /admin. Notifications
// (src/notify.js) go by email by default and by WhatsApp to the agent for the events
// the bot lists: a handoff, the daily summary (POST /jobs/send-daily-digest, called
// by the scheduler at 18:15; on Thursday it adds the week, on the 1st a summary of
// the previous month follows; the invoice comes from Grow in its own email), and each prompt recommendation from a closed test-mode
// trial. Links point to the dashboard and carry no token.
//
// Base 1.1.0: when the bot passes `outbound`, the dashboard can send a signup link and
// run campaigns (src/outbound.js), opt-out words from customers are recorded, the job
// POST /jobs/send-campaigns sends the next batch (scheduler: every 10 minutes), and
// Meta's statuses and quality warnings from the webhook update recipients or pause.

const { loadConfig } = require('./config');
const { createDeduplicator } = require('./security');
const { createWhatsAppClient } = require('./whatsapp');
const { createAiClient } = require('./ai');
const { createStorage } = require('./storage');
const { isWithinSendWindow, wallClock } = require('./schedule-window');
const { createConversationEngine } = require('./conversation');
const { createServer } = require('./server');
const { createAdmin } = require('./admin');
const { createTestMode } = require('./test-mode');
const { createEmailClient, recommendationEmail } = require('./email');
const { createNotifier } = require('./notify');
const { buildDigest } = require('./daily-summary');
const { createJobRunner } = require('./jobs');
const { createOutbound } = require('./outbound');

const DEFAULT_LEAD_STATUSES = Object.freeze(['new', 'in_progress', 'handoff', 'closed']);

/**
 * @param {{
 *   systemPrompt: string,
 *   tool: import('./ai').ToolDefinition,
 *   unsupportedReplyText: string,
 *   acceptedMediaTypes?: string[],
 *   mediaReceivedReplyText?: string,
 *   mediaRejectedReplyText?: string,
 *   mediaTypeLabels?: Record<string, string>,
 *   holidays?: Iterable<string>,
 *   replyHours?: 'window' | 'always',
 *   monthlyNote?: string,
 *   jobs?: Record<string, () => Promise<unknown>>,
 *   botName?: string,
 *   leadStatuses?: string[],
 *   schema?: import('./schema').Schema,
 *   leadFields?: string[],
 *   testMode?: {phones: string[], endKeyword: string, questions: string[], closingText: string},
 *   outbound?: {
 *     optOutReplyText: string,
 *     signup?: {template: import('./outbound').TemplateDef, link: string},
 *     templates?: Record<string, import('./outbound').TemplateDef>,
 *     optOutKeywords?: string[],
 *     fallbacks?: {name?: string},
 *     ramp?: Partial<import('./outbound').Ramp>,
 *     batchPerRun?: number
 *   },
 *   email?: import('./email').EmailClient,
 *   env?: Record<string, string | undefined>,
 *   storage?: import('./storage').Storage,
 *   whatsapp?: import('./whatsapp').WhatsAppClient,
 *   ai?: import('./ai').AiClient,
 *   now?: () => Date,
 *   log?: {info: (...args: unknown[]) => void, error: (...args: unknown[]) => void}
 * }} options
 *   acceptedMediaTypes, mediaReceivedReplyText, mediaRejectedReplyText, mediaTypeLabels:
 *   which media this bot takes (for example ['image', 'document'] for an ID photo), the
 *   acknowledgement, and the reply for other media ("I accept files only as {accepted}").
 *   Default: none accepted. See src/conversation.js.
 *   storage, whatsapp, ai and email are built from config unless passed in (tests, DRY RUN).
 *   email is used only when config has the email variables (NOTIFY_EMAIL is the recipient).
 *   leadStatuses: statuses the agent can set on the dashboard (per bot). Default: new,
 *   in_progress, handoff, closed. schema and leadFields: dashboard columns by field ID (F-12).
 *   testMode: tester phones, the end keyword and the 4 to 6 feedback questions (per bot).
 *   replyHours: when the bot answers customers who write to it. 'window' (default): only
 *   inside the send window, Sunday to Thursday 09:00 to 17:50, no holidays (decisions.md
 *   item 17). 'always': at any hour, every day (item 58). Outbound campaigns, signup links
 *   and test-mode questions always keep the send window.
 *   monthlyNote: one line for the monthly summary, for example "the invoice is sent separately by Grow".
 *   outbound: Meta-approved templates for the signup link and for campaigns, the opt-out
 *   confirmation text, and optionally the opt-out words and the daily limit defaults
 *   (src/outbound.js). Without it the bot sends no outbound messages.
 * @returns {{config: import('./config').Config, server: import('node:http').Server, testMode: object | null, listen: () => Promise<number>}}
 *   listen resolves with the port in use.
 */
function createBot(options) {
  const config = loadConfig(options.env || process.env);
  const now = options.now || (() => new Date());
  const holidays = options.holidays || [];

  const storage = options.storage || createStorage({ projectId: config.firestoreProjectId });
  const whatsapp =
    options.whatsapp || createWhatsAppClient({ token: config.whatsappToken, phoneNumberId: config.whatsappPhoneNumberId });
  const ai = options.ai || createAiClient({ apiKey: config.anthropicApiKey, model: config.aiModel });
  const log = options.log || console;
  const botName = options.botName || '';
  const inWindow = (when) => isWithinSendWindow(when, { holidays });
  const replyHours = options.replyHours === undefined ? 'window' : options.replyHours;
  if (replyHours !== 'window' && replyHours !== 'always') {
    throw new TypeError(`createBot: replyHours must be 'window' or 'always', got ${JSON.stringify(options.replyHours)}`);
  }
  // Customer replies only (item 58); outbound and test mode keep inWindow.
  const replyWindow = replyHours === 'always' ? () => true : inWindow;

  const email = config.email ? options.email || createEmailClient({ apiKey: config.email.apiKey, from: config.email.from }) : null;
  const notifyTo = config.email ? config.email.notifyTo : null;
  const leadLink = (id) => `${config.appBaseUrl.replace(/\/+$/, '')}/admin/leads/${encodeURIComponent(id)}`;
  const notifier = createNotifier({
    email,
    emailTo: notifyTo,
    whatsapp: config.agentWhatsApp ? whatsapp : null,
    agentPhone: config.agentWhatsApp ? config.agentWhatsApp.phone : null,
    whatsappEvents: config.agentWhatsApp ? [...config.agentWhatsApp.events] : [],
    whatsappTemplate: config.agentWhatsApp ? config.agentWhatsApp.template : null,
    log,
  });

  async function onHandoff({ conversationId, reason }) {
    await notifier.send('handoff', {
      subject: `${botName || 'בוט'}: לקוח מבקש נציג`,
      text: [`הלקוח ${conversationId} מבקש לדבר עם נציג.`, `סיבה: ${reason || 'לא צוינה'}`, `לפרטים בלוח: ${leadLink(conversationId)}`].join('\n'),
    });
  }

  const jobRunner = createJobRunner({ storage, now });
  async function sendDailyDigest() {
    const day = wallClock(now(), 'Asia/Jerusalem').date;
    let digest = null;
    let delivered = null;
    let monthly = null;
    const run = await jobRunner.runOnce('send-daily-digest', day, async () => {
      digest = await buildDigest({ storage, now, botName, dashboardUrl: config.appBaseUrl, monthlyNote: options.monthlyNote });
      delivered = await notifier.send('daily_summary', { subject: digest.daily.subject, text: digest.daily.text });
      if (digest.monthly) monthly = await notifier.send('monthly_summary', { subject: digest.monthly.subject, text: digest.monthly.text });
    });
    if (!digest) return { status: run.status };
    return {
      status: run.status,
      counts: digest.daily.counts,
      channels: delivered.channels,
      week: digest.week ? { from: digest.week.from, to: digest.week.to, totals: digest.week.totals, daysRecorded: digest.week.daysRecorded } : null,
      monthly: digest.monthly
        ? { from: digest.monthly.from, to: digest.monthly.to, totals: digest.monthly.totals, daysRecorded: digest.monthly.daysRecorded, channels: monthly.channels }
        : null,
    };
  }

  const testMode = options.testMode
    ? createTestMode({
        storage,
        whatsapp,
        ai,
        isWithinSendWindow: inWindow,
        now,
        questions: options.testMode.questions,
        closingText: options.testMode.closingText,
      })
    : null;

  async function onTrialClosed(trialId) {
    const saved = await testMode.proposeRecommendations({ trialId, currentPrompt: options.systemPrompt });
    for (const rec of saved) {
      try {
        // The email keeps its own layout (escaped fields, link to the recommendation page).
        const mail = recommendationEmail({
          to: notifyTo,
          botName: botName || 'בוט',
          recommendationId: rec.id,
          suggestion: `${rec.data.summary}\n${rec.data.change}`,
          reasoning: rec.data.reason,
          dashboardUrl: config.appBaseUrl,
        });
        await notifier.send('recommendation', { subject: mail.subject, text: mail.text, html: mail.html });
      } catch (err) {
        log.error(`bot: recommendation notification failed: ${err.name}: ${err.message}`);
      }
    }
  }

  const outbound = options.outbound
    ? createOutbound({ ...options.outbound, storage, whatsapp, isWithinSendWindow: inWindow, now, notifier, botName, log })
    : null;

  const engine = createConversationEngine({
    storage,
    whatsapp,
    ai,
    deduplicator: createDeduplicator({ storage }),
    isWithinSendWindow: replyWindow,
    now,
    unsupportedReplyText: options.unsupportedReplyText,
    acceptedMediaTypes: options.acceptedMediaTypes,
    mediaReceivedReplyText: options.mediaReceivedReplyText,
    mediaRejectedReplyText: options.mediaRejectedReplyText,
    mediaTypeLabels: options.mediaTypeLabels,
    systemPrompt: options.systemPrompt,
    tool: options.tool,
    onHandoff,
    testMode: testMode
      ? { phones: options.testMode.phones, endKeyword: options.testMode.endKeyword, module: testMode, onTrialClosed }
      : undefined,
    optOut: outbound
      ? { isOptOutText: outbound.isOptOutText, recordOptOut: outbound.recordOptOut, replyText: outbound.optOutReplyText }
      : undefined,
    onCustomerText: outbound ? outbound.recordReply : undefined,
    log,
  });

  const admin = createAdmin({
    adminToken: config.adminToken,
    storage,
    statuses: options.leadStatuses || DEFAULT_LEAD_STATUSES,
    testMode: testMode || undefined,
    outbound: outbound || undefined,
    schema: options.schema,
    leadFields: options.leadFields,
    botName,
    now,
    log,
  });

  // Base jobs first; a bot may add jobs or replace one by name.
  const baseJobs = { 'send-daily-digest': sendDailyDigest };
  if (outbound) baseJobs['send-campaigns'] = outbound.runCampaigns;
  const jobs = { ...baseJobs, ...(options.jobs || {}) };
  const server = createServer({ config, whatsapp, engine, jobs, admin, onEvents: outbound ? outbound.handleEvents : undefined, log: options.log });

  return {
    config,
    server,
    testMode,
    outbound,
    notifier,
    jobs,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => resolve(server.address().port));
      }),
  };
}

module.exports = { createBot, DEFAULT_LEAD_STATUSES };
