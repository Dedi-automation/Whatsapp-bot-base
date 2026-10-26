'use strict';

// B10 Notifications: email to the agent or owner (stage 2).
//
// Rebuilt from the MyDoctor email.js logic (not copied, CLAUDE.md rule 5):
// - Three kinds as in MyDoctor: a plain notification (handoff, health failure),
//   a prompt recommendation waiting for approval, and a validation error.
// - F-22: every field is escaped in the HTML body (src/html.js, including quotes).
//   Subjects and addresses may not contain line breaks (header injection).
// - F-04, F-05: no token in any link. The recommendation email links to the
//   dashboard page; the owner approves there after logging in (POST only).
// - Sent through the SendGrid HTTP API with an injected `fetch`, so the base adds
//   no dependency and tests never touch the network. MyDoctor used nodemailer
//   over SMTP to the same SendGrid account.
// - An email is a notification to the agent or owner, not a customer message, so
//   it does not wait for the send window (as health alerts, decisions.md item 36).
//
// Logs never contain addresses, subjects or bodies.
// Fake for tests and the dry run: src/fakes/email-fake.js.

const { EmailError } = require('./errors');
const { escapeHtml } = require('./html');

const API_URL = 'https://api.sendgrid.com/v3/mail/send';
const LINE_BREAK = /[\r\n]/;
const ADDRESS = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/**
 * @typedef {Object} EmailMessage
 * @property {string} to       one address
 * @property {string} subject  one line
 * @property {string} text     plain-text body
 * @property {string} html     HTML body; build it with the functions below so every field is escaped
 *
 * @typedef {Object} EmailClient
 * @property {(message: EmailMessage) => Promise<{accepted: true}>} send
 */

/**
 * @param {{apiKey: string, from: string, fetch?: typeof fetch}} options
 *   `from` must be a verified sender in the SendGrid account (SENDGRID_FROM_EMAIL).
 * @returns {EmailClient}
 * Errors: EmailError when the options or the message are invalid, or SendGrid
 * does not accept the message. Errors are reported, never swallowed.
 */
function createEmailClient(options) {
  const { apiKey, from } = options || {};
  const fetchFn = (options && options.fetch) || globalThis.fetch;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new EmailError('SENDGRID_API_KEY is required');
  checkAddress(from, 'SENDGRID_FROM_EMAIL');
  if (typeof fetchFn !== 'function') throw new EmailError('fetch is not available');

  return {
    async send(message) {
      checkMessage(message);
      let response;
      try {
        response = await fetchFn(API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: message.to }] }],
            from: { email: from },
            subject: message.subject,
            content: [
              { type: 'text/plain', value: message.text },
              { type: 'text/html', value: message.html },
            ],
          }),
        });
      } catch (err) {
        throw new EmailError(`SendGrid request failed: ${err && err.message}`);
      }
      // SendGrid answers 202 Accepted with an empty body.
      if (!response || response.status < 200 || response.status >= 300) {
        const status = response && response.status;
        throw new EmailError(`SendGrid did not accept the email: ${status}`, { status });
      }
      return { accepted: true };
    },
  };
}

function checkAddress(value, name) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new EmailError(`${name} is not a valid email address`);
  }
}

/** @param {EmailMessage} message */
function checkMessage(message) {
  if (!message || typeof message !== 'object') throw new EmailError('email message is required');
  checkAddress(message.to, 'to');
  const { subject, text, html } = message;
  if (typeof subject !== 'string' || subject.trim() === '') throw new EmailError('subject is required');
  if (LINE_BREAK.test(subject)) throw new EmailError('subject may not contain line breaks');
  if (typeof text !== 'string' || text.trim() === '') throw new EmailError('text is required');
  if (typeof html !== 'string' || html.trim() === '') throw new EmailError('html is required');
}

// Message builders. Pure functions: they only build the message, the caller sends it.
// Every value is escaped here, so callers pass raw values (F-22).

/** Subject from untrusted parts: line breaks become spaces. */
function oneLine(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

function rtlBlock(inner) {
  return `<div dir="rtl" style="font-family: sans-serif; line-height: 1.6;">${inner}</div>`;
}

/**
 * Plain notification: handoff to the agent, a failed health check.
 * @param {{to: string, subject: string, text: string}} input
 * @returns {EmailMessage}
 */
function notifyEmail({ to, subject, text }) {
  return {
    to,
    subject: oneLine(subject),
    text: String(text),
    html: rtlBlock(`<div style="white-space: pre-wrap;">${escapeHtml(text)}</div>`),
  };
}

/**
 * A prompt recommendation from test mode is waiting for the owner (decisions.md item 34).
 * The link opens the dashboard page of the recommendation. It carries no token:
 * the owner logs in and approves or rejects there. Nothing is applied by email.
 * @param {{to: string, botName: string, recommendationId: string, suggestion: string, reasoning: string, excerpt?: string, dashboardUrl: string}} input
 *   dashboardUrl: APP_BASE_URL. The path is built here.
 * @returns {EmailMessage}
 */
function recommendationEmail({ to, botName, recommendationId, suggestion, reasoning, excerpt, dashboardUrl }) {
  const link = recommendationLink(dashboardUrl, recommendationId);
  const subject = oneLine(`${botName}: הצעת שיפור לפרומפט לבדיקה (${recommendationId})`);
  const text = [
    `הצעת שיפור לפרומפט של ${botName}`,
    '',
    `ההצעה: ${suggestion}`,
    `נימוק: ${reasoning}`,
    excerpt ? `קטע לדוגמה: ${excerpt}` : null,
    '',
    'אישור לא משנה את הפרומפט אוטומטית. השינוי נעשה בנפרד.',
    `לאישור או דחייה, היכנס ללוח: ${link}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
  const html = rtlBlock(
    `<h2>הצעת שיפור לפרומפט של ${escapeHtml(botName)}</h2>` +
      `<p><strong>ההצעה:</strong><br>${escapeHtml(suggestion)}</p>` +
      `<p><strong>נימוק:</strong><br>${escapeHtml(reasoning)}</p>` +
      (excerpt
        ? `<p><strong>קטע לדוגמה:</strong></p><pre style="white-space: pre-wrap; background: #f5f5f5; padding: 10px;">${escapeHtml(excerpt)}</pre>`
        : '') +
      '<p>אישור <strong>לא</strong> משנה את הפרומפט אוטומטית. השינוי נעשה בנפרד.</p>' +
      `<p><a href="${escapeHtml(link)}">לאישור או דחייה בלוח</a></p>`
  );
  return { to, subject, text, html };
}

/**
 * Link to one recommendation on the dashboard. https only, no query string, no token (F-04).
 * @param {string} dashboardUrl
 * @param {string} recommendationId
 */
function recommendationLink(dashboardUrl, recommendationId) {
  let base;
  try {
    base = new URL(String(dashboardUrl));
  } catch {
    throw new EmailError('dashboardUrl (APP_BASE_URL) is not a valid URL');
  }
  if (base.protocol !== 'https:') throw new EmailError('dashboardUrl (APP_BASE_URL) must be https');
  if (typeof recommendationId !== 'string' || recommendationId === '') throw new EmailError('recommendationId is required');
  const root = base.origin + base.pathname.replace(/\/+$/, '');
  return `${root}/admin/recommendations/${encodeURIComponent(recommendationId)}`;
}

/**
 * Validation error, for example a form or a record that failed a check.
 * Same as notifyEmail but left to right, as in MyDoctor (technical content).
 * @param {{to: string, subject: string, text: string}} input
 * @returns {EmailMessage}
 */
function validationErrorEmail({ to, subject, text }) {
  return {
    to,
    subject: oneLine(subject),
    text: String(text),
    html: `<div style="font-family: sans-serif; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(text)}</div>`,
  };
}

module.exports = {
  createEmailClient,
  notifyEmail,
  recommendationEmail,
  recommendationLink,
  validationErrorEmail,
};
