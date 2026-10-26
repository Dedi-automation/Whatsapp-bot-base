'use strict';

// Dry run for B10 email (stage 2, S2-1). Nothing is sent.
// Uses the real email client with a recording fetch in place of the network,
// builds the three email kinds with hostile field values, and prints what would
// have been sent. Exit code 1 if any check fails.

const { createEmailClient, notifyEmail, recommendationEmail, validationErrorEmail } = require('../src/email');

const ATTACK = `<script>alert('x')</script>`;

async function main() {
  const requests = [];
  const recordingFetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { status: 202, ok: true };
  };
  const client = createEmailClient({ apiKey: 'dry-run-key', from: 'bot@example.com', fetch: recordingFetch });

  const messages = [
    notifyEmail({ to: 'agent@example.com', subject: `Handoff: ${ATTACK}`, text: `Customer name: ${ATTACK}\nWants a call tomorrow` }),
    recommendationEmail({
      to: 'owner@example.com',
      botName: 'Test bot',
      recommendationId: 'trial-7:2',
      suggestion: `Ask for dates first ${ATTACK}`,
      reasoning: 'Asked twice in the trial',
      excerpt: `customer: ${ATTACK}`,
      dashboardUrl: 'https://bot.example.com',
    }),
    validationErrorEmail({ to: 'owner@example.com', subject: 'Validation error', text: `Field phone: ${ATTACK}` }),
  ];
  for (const message of messages) await client.send(message);

  const checks = [
    ['3 emails would have been sent', requests.length === 3],
    ['all to the SendGrid API URL', requests.every((r) => r.url === 'https://api.sendgrid.com/v3/mail/send')],
    ['key only in the Authorization header', requests.every((r) => r.headers.Authorization === 'Bearer dry-run-key' && !r.url.includes('dry-run-key'))],
    ['no raw <script> in any HTML body', requests.every((r) => !r.body.content[1].value.includes('<script'))],
    ['no token in any link', requests.every((r) => !JSON.stringify(r.body).includes('token'))],
  ];

  for (const r of requests) {
    console.log('--- would send ---');
    console.log('to:     ', r.body.personalizations[0].to[0].email);
    console.log('subject:', r.body.subject);
    console.log('html:   ', r.body.content[1].value);
  }
  console.log('--- checks ---');
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? 'DRY RUN PASS (nothing was sent)' : 'DRY RUN FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error('DRY RUN ERROR', err);
  process.exitCode = 1;
});
