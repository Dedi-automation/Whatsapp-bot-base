'use strict';

// Notifications to the agent and the owner (stage 2, Dedi's decision 2026-10-26).
//
// One place decides how each event reaches people:
// - Email is the default channel: every event goes to NOTIFY_EMAIL when email is configured.
// - WhatsApp to the agent is optional, per event: only the events the bot lists
//   (AGENT_WHATSAPP_EVENTS) go to AGENT_WHATSAPP_PHONE.
// - Events: 'handoff' (a customer asked for an agent), 'daily_summary' (the day's
//   summary, sent by the scheduler at 18:15; on Thursday it also holds the week),
//   'monthly_summary' (the previous month, on the 1st, after the daily summary),
//   'recommendation' (a prompt improvement from test mode, waiting for the owner).
// - These messages go to the agent or owner, not to customers, so they are sent at
//   any hour, like health alerts (decisions.md item 36). 18:15 is after the 17:50
//   customer window on purpose.
// - WhatsApp outside a 24-hour conversation needs a template approved by Meta. When
//   AGENT_WHATSAPP_TEMPLATE is set, the message is sent as that template with one
//   body parameter (the text on one line, as Meta requires); otherwise as free text,
//   which Meta delivers only while the agent wrote to the number in the last 24 hours.
// - A failing channel is logged and reported; the other channels still send.
//   Errors are never thrown to the caller, so a notification never breaks the flow
//   (the handoff is recorded either way).
//
// Logs never contain addresses, phone numbers or message text.

const { notifyEmail } = require('./email');

const EVENTS = Object.freeze(['handoff', 'daily_summary', 'monthly_summary', 'recommendation']);
// Meta template parameters may not contain new lines, tabs or more than 4 spaces in a row.
const TEMPLATE_PARAM_MAX = 1000;

/**
 * @typedef {'handoff' | 'daily_summary' | 'monthly_summary' | 'recommendation'} NotifyEvent
 *
 * @typedef {Object} NotifyResult
 * @property {NotifyEvent} event
 * @property {Array<{channel: 'email' | 'whatsapp', ok: boolean, detail?: string}>} channels
 *   Empty when no channel is set up for the event.
 */

/**
 * @param {{
 *   email?: import('./email').EmailClient | null,
 *   emailTo?: string | null,
 *   whatsapp?: import('./whatsapp').WhatsAppClient | null,
 *   agentPhone?: string | null,
 *   whatsappEvents?: string[],
 *   whatsappTemplate?: {name: string, language: string} | null,
 *   log?: {info: (...args: unknown[]) => void, error: (...args: unknown[]) => void}
 * }} deps
 *   email + emailTo: the default channel for every event (both or neither).
 *   whatsapp + agentPhone + whatsappEvents: WhatsApp to the agent for the listed events only.
 * @returns {{send: (event: NotifyEvent, message: {subject: string, text: string, html?: string}) => Promise<NotifyResult>, channelsFor: (event: NotifyEvent) => string[]}}
 * Errors: TypeError at startup for an unknown event name, or WhatsApp events without a phone.
 */
function createNotifier(deps = {}) {
  const { email = null, emailTo = null, whatsapp = null, agentPhone = null, whatsappTemplate = null, log = console } = deps;
  const whatsappEvents = deps.whatsappEvents || [];
  const unknown = whatsappEvents.filter((e) => !EVENTS.includes(e));
  if (unknown.length > 0) throw new TypeError(`Unknown notification events: ${unknown.join(', ')} (known: ${EVENTS.join(', ')})`);
  if (whatsappEvents.length > 0 && (!whatsapp || typeof agentPhone !== 'string' || agentPhone.trim() === '')) {
    throw new TypeError('WhatsApp notifications need the agent phone (AGENT_WHATSAPP_PHONE)');
  }
  if (Boolean(email) !== Boolean(emailTo)) throw new TypeError('email and emailTo go together');
  if (whatsappTemplate && (!whatsappTemplate.name || !whatsappTemplate.language)) {
    throw new TypeError('whatsappTemplate needs a name and a language');
  }
  const onWhatsApp = new Set(whatsappEvents);

  function channelsFor(event) {
    const channels = [];
    if (email) channels.push('email');
    if (onWhatsApp.has(event)) channels.push('whatsapp');
    return channels;
  }

  async function sendWhatsApp(text) {
    if (whatsappTemplate) {
      await whatsapp.sendTemplate({ to: agentPhone, templateName: whatsappTemplate.name, language: whatsappTemplate.language, params: [templateParam(text)] });
    } else {
      await whatsapp.sendText({ to: agentPhone, text });
    }
  }

  return {
    channelsFor,

    async send(event, message) {
      if (!EVENTS.includes(event)) throw new TypeError(`Unknown notification event: ${event}`);
      const results = [];
      for (const channel of channelsFor(event)) {
        try {
          if (channel === 'email') {
            const built = notifyEmail({ to: emailTo, subject: message.subject, text: message.text });
            await email.send(message.html ? { ...built, html: message.html } : built);
          } else {
            await sendWhatsApp(message.text);
          }
          results.push({ channel, ok: true });
        } catch (err) {
          log.error(`notify: ${event} by ${channel} failed: ${err && err.name}`);
          results.push({ channel, ok: false, detail: `${err && err.name}: ${err && err.message}` });
        }
      }
      if (results.length === 0) log.info(`notify: ${event}: no channel set up`);
      return { event, channels: results };
    },
  };
}

/** One line, no tabs, no runs of more than 3 spaces, within Meta's length limit. */
function templateParam(text) {
  const line = String(text).replace(/[\r\n\t]+/g, ' | ').replace(/ {4,}/g, '   ').trim();
  return line.length > TEMPLATE_PARAM_MAX ? `${line.slice(0, TEMPLATE_PARAM_MAX - 1)}…` : line;
}

module.exports = { createNotifier, EVENTS, templateParam };
