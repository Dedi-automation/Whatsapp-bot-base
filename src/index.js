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

const { loadConfig } = require('./config');
const { createDeduplicator } = require('./security');
const { createWhatsAppClient } = require('./whatsapp');
const { createAiClient } = require('./ai');
const { createStorage } = require('./storage');
const { isWithinSendWindow } = require('./schedule-window');
const { createConversationEngine } = require('./conversation');
const { createServer } = require('./server');

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
 *   storage, whatsapp and ai are built from config unless passed in (tests, DRY RUN).
 * @returns {{config: import('./config').Config, server: import('node:http').Server, listen: () => Promise<number>}}
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

  const engine = createConversationEngine({
    storage,
    whatsapp,
    ai,
    deduplicator: createDeduplicator({ storage }),
    isWithinSendWindow: (when) => isWithinSendWindow(when, { holidays }),
    now,
    unsupportedReplyText: options.unsupportedReplyText,
    acceptedMediaTypes: options.acceptedMediaTypes,
    mediaReceivedReplyText: options.mediaReceivedReplyText,
    mediaRejectedReplyText: options.mediaRejectedReplyText,
    mediaTypeLabels: options.mediaTypeLabels,
    systemPrompt: options.systemPrompt,
    tool: options.tool,
  });

  const server = createServer({ config, whatsapp, engine, jobs: options.jobs, log: options.log });

  return {
    config,
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => resolve(server.address().port));
      }),
  };
}

module.exports = { createBot };
