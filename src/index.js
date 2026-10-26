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
// Stage 2 wiring: the admin dashboard (B11) is mounted at /admin; when email is
// configured (B10), a handoff emails the agent and each prompt recommendation from
// a closed test-mode trial emails the owner a dashboard link (no token in it).

const { loadConfig } = require('./config');
const { createDeduplicator } = require('./security');
const { createWhatsAppClient } = require('./whatsapp');
const { createAiClient } = require('./ai');
const { createStorage } = require('./storage');
const { isWithinSendWindow } = require('./schedule-window');
const { createConversationEngine } = require('./conversation');
const { createServer } = require('./server');
const { createAdmin } = require('./admin');
const { createTestMode } = require('./test-mode');
const { createEmailClient, notifyEmail, recommendationEmail } = require('./email');

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
 *   jobs?: Record<string, () => Promise<unknown>>,
 *   botName?: string,
 *   leadStatuses?: string[],
 *   schema?: import('./schema').Schema,
 *   leadFields?: string[],
 *   testMode?: {phones: string[], endKeyword: string, questions: string[], closingText: string},
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

  const email = config.email ? options.email || createEmailClient({ apiKey: config.email.apiKey, from: config.email.from }) : null;
  const notifyTo = config.email ? config.email.notifyTo : null;
  const leadLink = (id) => `${config.appBaseUrl.replace(/\/+$/, '')}/admin/leads/${encodeURIComponent(id)}`;

  async function onHandoff({ conversationId, reason }) {
    if (!email) return;
    await email.send(
      notifyEmail({
        to: notifyTo,
        subject: `${botName || 'בוט'}: לקוח מבקש נציג`,
        text: [`הלקוח ${conversationId} מבקש לדבר עם נציג.`, `סיבה: ${reason || 'לא צוינה'}`, `לפרטים בלוח: ${leadLink(conversationId)}`].join('\n'),
      })
    );
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
    if (!email) return;
    for (const rec of saved) {
      try {
        await email.send(
          recommendationEmail({
            to: notifyTo,
            botName: botName || 'בוט',
            recommendationId: rec.id,
            suggestion: `${rec.data.summary}\n${rec.data.change}`,
            reasoning: rec.data.reason,
            dashboardUrl: config.appBaseUrl,
          })
        );
      } catch (err) {
        log.error(`bot: recommendation email failed: ${err.name}: ${err.message}`);
      }
    }
  }

  const engine = createConversationEngine({
    storage,
    whatsapp,
    ai,
    deduplicator: createDeduplicator({ storage }),
    isWithinSendWindow: inWindow,
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
    log,
  });

  const admin = createAdmin({
    adminToken: config.adminToken,
    storage,
    statuses: options.leadStatuses || DEFAULT_LEAD_STATUSES,
    testMode: testMode || undefined,
    schema: options.schema,
    leadFields: options.leadFields,
    botName,
    now,
    log,
  });

  const server = createServer({ config, whatsapp, engine, jobs: options.jobs, admin, log: options.log });

  return {
    config,
    server,
    testMode,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => resolve(server.address().port));
      }),
  };
}

module.exports = { createBot, DEFAULT_LEAD_STATUSES };
