# whatsapp-bot-base

Shared base for WhatsApp bots. A bot is its own repository that pins one version of
this base. The base is never deployed by itself and holds no client data, tokens or
product prompts (documents/spec.md section 2).

The design, decisions and test plan are in `documents/`. Changes per version are in
`CHANGELOG.md`.

## Using the base in a bot

Pin an exact tag in the bot's `package.json`:

```json
{
  "dependencies": {
    "whatsapp-bot-base": "github:Dedi-automation/Whatsapp-bot-base#v1.0.0"
  }
}
```

A new base tag changes nothing in the bot. To upgrade on purpose, install the new tag
by name, which updates both `package.json` and `package-lock.json` (editing
`package.json` alone keeps the old commit from the lock file):

```
npm install whatsapp-bot-base@github:Dedi-automation/Whatsapp-bot-base#v1.1.0
```

Then run the bot's tests and its DRY RUN, and record the upgrade in the bot's log (T-15). The repository
is private, so the machine that installs the bot needs read access to it.

```js
const { createBot } = require('whatsapp-bot-base');

const bot = createBot({
  botName: 'Travel insurance',
  systemPrompt,            // the bot's agent prompt
  tool,                    // the reply tool definition
  unsupportedReplyText,    // reply to a message type the bot does not read
  // optional: acceptedMediaTypes, leadStatuses, schema, leadFields, testMode,
  // holidays, jobs, monthlyNote (see the JSDoc in src/index.js)
});
bot.listen();
```

Node.js 22 or later.

## Environment variables

Required (startup stops and names every missing one): `ANTHROPIC_API_KEY`, `AI_MODEL`,
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, `FIRESTORE_PROJECT_ID`, `ADMIN_TOKEN`, `SCHEDULED_JOB_TOKEN`,
`APP_BASE_URL`. Optional: `PORT`; email `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`,
`NOTIFY_EMAIL` (all three or none); WhatsApp to the agent `AGENT_WHATSAPP_PHONE`,
`AGENT_WHATSAPP_EVENTS`, `AGENT_WHATSAPP_TEMPLATE`, `AGENT_WHATSAPP_TEMPLATE_LANGUAGE`.
Firestore credentials come from the runtime's Google service account.

Secrets live in the deployment's environment, never in the repository.

## Routes

- `GET`/`POST /whatsapp-webhook`: incoming WhatsApp messages (verify token, signature).
- `GET /health`
- `POST /jobs/<name>`: scheduled jobs, job token in the `Authorization` header. The base
  provides `send-daily-digest` (schedule it at 18:15 Israel time); a bot adds its own.
- `/admin/...`: the agent dashboard (login form, then a signed cookie).

## Tests

- `npm test` runs the whole suite. Firestore cases need the emulator
  (`FIRESTORE_EMULATOR_HOST`); GitHub Actions runs it on every push.
- `node scripts/release-check.js`: T-01 to T-17 (test-plan.md).
- `node scripts/dry-run.js`: T-09, the full flow with nothing sent.
- Workflow `smoke-real` (manual): the real test Firestore project, test WhatsApp number
  and SendGrid, with repository secrets.
