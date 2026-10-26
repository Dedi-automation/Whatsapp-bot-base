'use strict';

// HTTP entry (Branch B). Routes from spec.md Appendix B, approved by the owner 2026-10-26.
// Plain node:http, no framework, so the base keeps zero dependencies.
//
//   GET  /whatsapp-webhook   Meta webhook registration (hub.verify_token)
//   POST /whatsapp-webhook   incoming messages; X-Hub-Signature-256 checked first (T-02)
//   GET  /health             liveness only
//   POST /jobs/<name>        scheduled jobs; job token in the Authorization header (T-16)
//   /admin/...               admin dashboard (B11, src/admin.js), when an admin handler is passed
//
// Not in the base: /test-sheet (F-26), /billing/*, /demo-intake.
//
// Logs never contain message text, phone numbers or tokens.

const http = require('node:http');
const { verifyWhatsAppSignature, checkBearerToken } = require('./security');

const MAX_BODY_BYTES = 1024 * 1024;
const JOB_NAME = /^[a-z0-9-]+$/;

/**
 * @param {{
 *   config: import('./config').Config,
 *   whatsapp: import('./whatsapp').WhatsAppClient,
 *   engine: {handleIncoming: (message: import('./whatsapp').IncomingMessage) => Promise<import('./conversation').Outcome>},
 *   jobs?: Record<string, () => Promise<unknown>>,
 *   admin?: {handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>},
 *   log?: {info: (...args: unknown[]) => void, error: (...args: unknown[]) => void}
 * }} deps
 *   jobs: handlers by route name, for example {'send-reminders': fn}. Branch D supplies them.
 * @returns {import('node:http').Server}
 */
function createServer(deps) {
  const { config, whatsapp, engine, jobs = {}, admin, log = console } = deps;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/whatsapp-webhook') {
      if (req.method === 'GET') return verifyWebhook(url, res);
      if (req.method === 'POST') return receiveWebhook(req, res);
      return send(res, 405, { error: 'method not allowed' });
    }

    if (path === '/health') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { ok: true });
    }

    if (path.startsWith('/jobs/')) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      return runJob(req, res, path.slice('/jobs/'.length));
    }

    if (admin && (path === '/admin' || path.startsWith('/admin/'))) {
      return admin.handle(req, res);
    }

    return send(res, 404, { error: 'not found' });
  }

  // Meta's registration handshake. The verify token in the query is Meta's protocol;
  // it is a separate token from the admin and job tokens.
  function verifyWebhook(url, res) {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === config.whatsappVerifyToken && challenge) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(challenge);
    }
    return send(res, 403, { error: 'forbidden' });
  }

  async function receiveWebhook(req, res) {
    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      res.setHeader('Connection', 'close');
      return send(res, err.statusCode || 400, { error: err.message });
    }

    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!verifyWhatsAppSignature({ rawBody, signatureHeader, appSecret: config.whatsappAppSecret })) {
      log.error('webhook: rejected, bad signature');
      return send(res, 401, { error: 'invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return send(res, 400, { error: 'invalid JSON' });
    }

    // Messages are handled before the response, so the work is done while the
    // request is open (Cloud Run may pause CPU after a response). A failure of one
    // message is logged and does not stop the others. The answer is 200 either way:
    // the message ID is already marked as seen, so a retry from Meta would only be
    // dropped as a duplicate.
    const results = [];
    for (const message of whatsapp.parseIncoming(payload)) {
      try {
        const outcome = await engine.handleIncoming(message);
        results.push(outcome.status);
        log.info(`webhook: ${message.messageId} ${outcome.status}`);
      } catch (err) {
        results.push('error');
        log.error(`webhook: ${message.messageId} failed: ${err.name}: ${err.message}`);
      }
    }
    return send(res, 200, { received: results.length, results });
  }

  async function runJob(req, res, name) {
    if (!checkBearerToken({ url: req.url, headers: req.headers, expected: config.scheduledJobToken })) {
      return send(res, 401, { error: 'unauthorized' });
    }
    if (!JOB_NAME.test(name) || !Object.prototype.hasOwnProperty.call(jobs, name)) {
      return send(res, 404, { error: 'unknown job' });
    }
    try {
      const result = await jobs[name]();
      log.info(`job: ${name} done`);
      return send(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (err) {
      log.error(`job: ${name} failed: ${err.name}: ${err.message}`);
      return send(res, 500, { ok: false, error: 'job failed' });
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`server: ${err.name}: ${err.message}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop keeping data, let the rest drain, and answer 413 on a closing connection.
        const err = new Error('body too large');
        err.statusCode = 413;
        req.removeAllListeners('data');
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

module.exports = { createServer, MAX_BODY_BYTES };
