# Shared Base Spec for WhatsApp Bots (based on MyDoctor)

Date: 2026-10-23 · Version 0.3 (updated for parallel build)

## 1. Purpose and scope

The base is a template, not a running product. Every bot (travel, car, home, savings, collections, leads) is a new repo built on a locked version of the base, with its own config, agent prompt and knowledge sources.

- Phase A builds the base only. The travel bot is Phase B and is not covered here.
- Send window: Sunday to Thursday, 09:00 to 17:50 Israel time, inclusive. Nothing is sent after 17:50 on any day (decisions.md, item 17).
- The base lives in a new private repo named whatsapp-bot-base. MyDoctor stays as a read-only reference.
- All findings in section 5 are fixed in the new base, not in MyDoctor.
- This spec is based on reading every file in MyDoctor at commit b91ca9d. Nothing was run or tested against live Google Sheets or WhatsApp. Anything not verified is marked TO VERIFY.

## 2. How the base and bots work together

- The base is a package with versions (for example 1.0.0). It is never deployed to a client.
- A bot is a new repo. It depends on one base version and contains only: config, agent prompt, product knowledge base, and its own environment variables (WhatsApp token, phone number ID, its own Firestore project and API keys).
- Upgrades are explicit. A new base version does not change any bot until that bot's owner changes its version number and its tests pass. A base fix reaches a bot only when someone upgrades it.
- The base contains no client data, no tokens and no product prompts.
- Distribution: a versioned package, pinned per bot (decided in principle; see decisions.md).

## 3. Current code state (MyDoctor, commit b91ca9d)

- Stack: Node.js (CommonJS), Express 4, googleapis (Sheets v4), nodemailer via SendGrid SMTP, dotenv.
- Storage today: Google Sheets, columns matched by Hebrew header name. In the base: Firestore (section 7).
- WhatsApp: Cloud API called directly at graph.facebook.com/v21.0, template messages with parameters, X-Hub-Signature-256 verification.
- AI: direct call to api.anthropic.com/v1/messages with forced tool choice (send_whatsapp_reply). The prompt is a template with {placeholders}.
- Time: Hebcal holiday data. Send window Sunday to Thursday, 09:00 to 17:50 Israel time.
- Billing: Grow (Meshulam) code exists but is not connected to server.js. It is imported by campaign.js. Outside the base.
- Deployment (per docs, TO VERIFY): Cloud Run in europe-west1 with Cloud Scheduler.
- package.json has no engines field, so the Node 18+ requirement (for fetch) is not declared.

## 4. File map: decision per file

| File | Lines | Decision | Reason | Findings |
|---|---|---|---|---|
| src/security.js | 91 | Keep | Signature check and constant-time secret comparison | F-14 |
| src/schedule-window.js | 144 | Keep | Send window and holidays, no data dependency | none |
| src/whatsapp.js | 115 | Keep and fix | Clean message send and parse, with error handling | F-20 |
| src/sheets.js | 147 | Keep and fix | Column access by name; replaced by Firestore in base | F-07 |
| src/columns.js | 95 | Fix | Schema per tab; add header check at startup | F-07 |
| src/claude.js | 101 | Fix | Fail on missing variables; model from config | F-10 |
| src/webhook.js | 392 | Rewrite | Conversation handling and row writes in one engine | F-27 |
| src/leads.js | 169 | Rewrite | Full scan of all tabs; strict ID comparisons | F-13 |
| src/server.js | 89 | Rewrite | Manual router registration; temporary /test-sheet route | F-26 |
| src/auth.js | 48 | Remove | Duplicate of sheets.js auth | F-19 |
| src/reminders.js | 150 | Rewrite | Reads one tab only; broken date parsing | F-15, F-16 |
| src/digest.js | 108 | Rewrite | Reads one tab only | F-15, F-16 |
| src/email.js | 98 | Keep and fix | SMTP sending; separate templates; escape all fields | F-22 |
| src/suggestions.js | 78 | Rewrite | Status change on GET with token in URL | F-05 |
| src/improvement-review.js | 192 | Decision needed | Optional module; sends prompt and transcripts to model and email | F-23 |
| src/health-check.js | 137 | Keep and fix | Smoke test; hard-coded phone number | F-17 |
| src/archive.js | 227 | Fix | Move check list and start date to config | F-17 |
| src/demo.js | 322 | Rewrite | Generic lead intake; demo content stays in demo module | F-18 |
| src/employees-helper.js | 127 | Rewrite | Reads columns by position | F-11 |
| src/pipeline-status.js | 103 | Keep and fix | Writes by header name; shared status module | none |
| src/pipeline-tracker.js | 161 | Delete | Reads columns by position; hard-coded status | F-12 |
| src/admin.js | 561 | Rewrite | HTML built from strings; token in URL | F-04, F-21, F-13 |
| src/campaign.js | 959 | Rewrite | Large file; split into dashboard, import, send | F-06, F-08, F-09, F-04 |
| src/billing.js | 867 | Outside base | Grow billing; not connected to server.js | F-02, F-03 |
| src/admin-pipeline-routes.js | 1094 | Rewrite | HTML output without escaping; fixed columns | F-01, F-04, F-12 |
| src/abigail-system-prompt-unified.md | 865 | Keep and fix | Business content; remove edit notes and variables | F-28, F-29 |
| README.md | 50 | Rewrite | Contains key rotation instructions; not copied | F-24 |
| package.json | 18 | Keep and fix | Remove google-auth-library; add engines | F-25 |
| .gitignore | short | Keep | Covers node_modules, .env, .env.local | none |
| docs/PIPELINE-*.md (4 files) | about 1,100 | Delete | Pipeline docs for code that does not exist | none |
| docs/demo-integration.js | 142 | Delete | Not used anywhere | none |

Line counts are approximate.

## 5. Findings (29), by severity

Severity: Critical = financial loss or private data exposure. High = production impact or silent error. Medium = acceptable for now. Low = cleanup.

| ID | Severity | Location | Finding | Status |
|---|---|---|---|---|
| F-01 | Critical | admin-pipeline-routes.js:908, 923, 949, 968 | Values from the database are injected into dashboard HTML without escaping. A stored script could run in an employee's browser. | Open |
| F-02 | Critical | campaign.js:9, 857; billing.js:702 | campaign.js imports billing.js and calls checkAgentBalances without await. | Open |
| F-03 | Critical | billing.js:702-727 | checkAgentBalances continues without a lock. A repeated run can charge twice. | Open |
| F-04 | High | admin.js, campaign.js, admin-pipeline-routes.js | Admin and agent tokens are in URL paths. They can leak into logs, history and proxies. | Open |
| F-05 | High | suggestions.js:34 | Status changes on GET with a token in the query string. A link scanner can trigger the change. | Open |
| F-06 | High | campaign.js:840-910 | Outbound sending has no lock. Overlapping runs can send the same customer two messages. | Open |
| F-07 | High | columns.js, sheets.js | No header check on startup. A column name with a trailing space (preferredCallbackTime) fails silently. | Open |
| F-08 | High | campaign.js:295 | Sending has no rate limit and no authorization check. | Open |
| F-09 | Medium | campaign.js:381 | Import has no de-duplication against existing leads. | Open |
| F-10 | High | claude.js:80; prompt | A missing variable renders as an empty string. The model name claude-sonnet-5 is not verified. | TO VERIFY |
| F-11 | Medium | employees-helper.js:48 | Commission column is read by position (row[5]). | Open |
| F-12 | Critical | pipeline-tracker.js:24; admin-pipeline-routes.js:1045-1067 | Reads and writes use column position, not header name. Wrong column after a sheet change. | Open |
| F-13 | Medium | leads.js:131; admin.js:291, 329; digest.js:61 | String comparisons without normalization (spaces, case). | Open |
| F-14 | Medium | security.js (logSecurityConfig) | Missing config is only logged; the app starts without a secret. | Open |
| F-15 | High | reminders.js:64; digest.js:37 | Reminders and daily digest read only the main leads tab. Other agents' customers get no reminders. | Open |
| F-16 | High | webhook.js:222; reminders.js:87; digest.js:43 | DD/MM/YYYY dates are written and read with new Date. | TO VERIFY |
| F-17 | Medium | health-check.js:11; archive.js:33 | Phone number and start date are hard-coded. | Open |
| F-18 | High | demo.js:107 | Message 3 shows fixed statistics to the lead. Claims are not sourced. | Open, needs review |
| F-19 | Low | auth.js | Duplicate Sheets auth alongside sheets.js. Two sources of truth. | Open |
| F-20 | Medium | whatsapp.js (parseIncomingMessage) | Non-text messages become an empty string. The bot may answer nothing. | TO VERIFY |
| F-21 | Medium | admin.js (HTML templates) | No central escape layer for templates. Same risk class as F-01. | TO VERIFY |
| F-22 | Low | email.js | Email content must be escaped for every field. | TO VERIFY |
| F-23 | Medium | improvement-review.js:116-119 | Full prompt and up to 20 transcripts sent to the model and to email. Cost and privacy. | Open |
| F-24 | High | README.md | Contains a rotation procedure for a key that was exposed in chat. Instructions are out of date. | Open (see decisions.md) |
| F-25 | Low | package.json | google-auth-library is unused; no engines field. | Open |
| F-26 | Low | server.js | Temporary /test-sheet route still in code. | Open |
| F-27 | Medium | webhook.js:368 | Full transcript written into a single cell. May exceed the Sheets cell limit. | TO VERIFY |
| F-28 | Medium | abigail-system-prompt-unified.md:3-26 | Edit notes and change log are at the top of the prompt sent to the model. | Open |
| F-29 | Critical | prompt | The prompt contains warranty claims and prices that were not verified. They could reach a customer as wrong facts. | Open, verify with agent |

Note on F-10: the first count gave 20 missing names; a second count gave 21. Recount before closing.

## 6. Prompt variables

The prompt has 36 names in braces. 20 of them are not sent as keys by the code (first count; recount pending):

- agent_phone, agent_callback_phone
- approved_adult_price, approved_child_price, approved_spouse_price
- approved_gold_price, approved_gold_adult_price, approved_gold_child_addon_price, approved_gold_child_standalone_price
- approved_discount_text, approved_offer_expiration, approved_tariff_url
- teachers_terms_approved
- agent_action_required, handoff_reason, opt_out, followup_at, followup_status, preferred_callback_time, preferred_contact_method

Several of these look like tool output fields rather than template variables. Each must be checked.

Rule for the base: the prompt is rendered from a closed list of fields. A missing field is an explicit error, never an empty string (F-10, F-29).

## 7. Decisions (from Dedi's answers, 2026-10-23)

- Data store: Firestore. One collection per bot. (Approved)
- Base repo: new project, private repo named whatsapp-bot-base. (Approved)
- Fixes: applied in the new base only, not in MyDoctor. (Approved)
- Secrets: new keys and tokens in the new project. Old keys are not copied. (Approved). Revocation of the old key: TO CONFIRM.
- AI model for first build: Haiku 5.5 (sufficient for now). Exact model string to verify before module B6. Model set in config only.
- Billing (Grow) and employee/commission modules: outside the base. (Approved)
- One bot per agent: each bot is a separate system built on a locked base version. The base allows copying and swapping token, profile and sources without code changes. (Approved)
- Transcript retention: kept until the end of the travel insurance policy; otherwise agreed with the agent. (Approved)
- Ofir lead routing: outside the base; specified separately. (Approved)
- Prompts, prices, reminders and outbound messages: defined per bot. (Approved)
- Demo bot: conversation only; no form and no template in the base. (Approved)
- Test setup: separate Firestore project, separate test WhatsApp number, test data only. (Approved)
- New WhatsApp numbers can be blocked (error #133010). Use the existing D&D Meta business account. TO CONFIRM.
- Distribution: versioned package, pinned per bot. (Agreed in principle)
- Source of truth for documents: git. Claude Docs pages are read-only views. (Proposed, TO CONFIRM)

## 8. Build order

Step 0 - Stubs and contracts (one session, before any branch starts). For each module B1, B2, B3, B4, B5, B6, B7, B8, B9, B12, B13 (B10 and B11 later): write the interface (types, inputs, outputs, errors), a fake implementation (B3 uses an in-memory store), and failing tests that describe the behavior. Merge step 0.

Step 1 - Parallel branches (section 10). Each branch works against the stubs and fakes, so it does not wait for other branches. Each module closes the findings it owns (section 5) and turns its failing tests green.

Step 2 - Integration. Replace fakes with real Firestore and WhatsApp test setup. Run T-01 to T-17 and the DRY RUN (T-09).

Step 3 - Base 1.0.0 tag. Only when all tests pass and the log is recorded.

Step 4 - Travel bot. Created from base 1.0.0. Starts only after step 3.

Send window for every step: Sunday to Thursday, 09:00 to 17:50 Israel time, inclusive. Nothing is sent after 17:50 on any day.

Exit rule for each step: its tests pass and the result is written to project-log.md.

## 9. Test mode and feedback (base module)

- Every bot includes a test mode: the agent holds a trial conversation with the bot, then ends it.
- At the end, the bot asks 4 to 6 questions to improve it.
- Notes are saved as improvement items for the next version.
- Work cycle: build conversation from the client's needs, test and comment, fix, test again, until the client approves.
- Open question: where screenshots are stored and who can see the notes.

## 10. Parallel work

Step 0 is the only sequential part. After it is merged, five branches run at the same time. Each branch has one owner and its own tests. No branch edits another branch's files.

- Branch A - Data: B4 schema, then B3 Firestore implementation.
- Branch B - WhatsApp and entry: B1 config, B2 security, B5 WhatsApp client, then B7 conversation engine (uses fakes for B5 and B6 until they are merged).
- Branch C - AI: B6 AI client.
- Branch D - Scheduling: B8 send window, B9 scheduled jobs, B13 archive (uses fake B3).
- Branch E - Testing: B12 health check, and the test mode in section 9.

Integration gate: after all branches merge, one run with one message per branch, then T-01 to T-17.

PROPOSED: B10 (email) and B11 (admin dashboard) are postponed to a later phase.

## 11. Base modules (contracts)

| Module | Content | Source | What enters the base |
|---|---|---|---|
| B1 Config | Load environment variables; fail at startup if a required variable is missing | New | Clear startup error (F-14) |
| B2 Security | WhatsApp signature check, admin and job tokens, duplicate message rejection | security.js | Tokens in a header, not in the URL (F-04) |
| B3 Storage | Read and write by record ID, backed by Firestore | New (replaces sheets.js) | Locked interface; modules never call the database directly |
| B4 Schema | Field names by ID; header and field check at startup | columns.js | Required before F-07 and F-12 are closed |
| B5 WhatsApp client | Send, templates, parse incoming messages | whatsapp.js | Handle non-text messages (F-20) |
| B6 AI client | Prompt loading, missing-variable check (explicit error), model from config | claude.js | Fixes F-10 and F-29 |
| B7 Conversation engine | Receive message, window check, save transcript, handoff to agent | webhook.js, leads.js | Rewrite (F-11, F-13, F-27) |
| B8 Send window | Sunday to Thursday, 09:00 to 17:50 inclusive, Israel time, holidays. Nothing is sent after 17:50 on any day | schedule-window.js | Keep |
| B9 Scheduled jobs | Reminders and digest with locking and duplicate-run protection | New | Fixes F-06, F-15, F-16 |
| B10 Notifications | Email to agent | email.js | Escape all fields (F-22). Postponed |
| B11 Admin dashboard | View and edit agents | admin.js | Rewrite (F-01, F-04, F-21). Postponed |
| B12 Health check | Check services and storage | health-check.js | Numbers from config (F-17) |
| B13 Archive | Move old records to archive (optional) | archive.js | Config for check list and start date (F-17) |

Outside the base: billing, employees and commissions, lead import and campaign sending, pipeline, demo content. Each bot defines these if needed.

## 12. Appendix A: environment variables (proposed)

| Name | Purpose | Note |
|---|---|---|
| ANTHROPIC_API_KEY | Claude API | New key for new project |
| WHATSAPP_TOKEN | Sending | Per bot |
| WHATSAPP_PHONE_NUMBER_ID | Sending number | Per bot |
| WHATSAPP_APP_SECRET | Signature check | Per bot |
| WHATSAPP_VERIFY_TOKEN | Webhook registration | Per bot |
| Firestore project and credentials | Storage | Variable names set in step 0 (TO CONFIRM) |
| ADMIN_TOKEN | Admin routes | Sent in header (proposed) |
| SCHEDULED_JOB_TOKEN | Scheduled job routes | Sent in header (proposed) |
| SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, NOTIFY_EMAIL | Email | Used by B10, postponed |
| APP_BASE_URL | Links in messages | |
| PORT | Server port | |

Not in the base: Grow variables, Sheets variables, demo variables, outbound variables, WEBHOOK_URL.

## 13. Appendix B: HTTP routes (proposed)

- GET and POST /whatsapp-webhook: incoming messages. Verify token and signature.
- GET /health: liveness check.
- POST /jobs/send-reminders, /jobs/send-daily-digest, /jobs/archive-leads: scheduled jobs. Job token in header.
- /admin/...: admin dashboard (postponed). Admin token in header.
- Not in the base: /test-sheet (F-26), /billing/*, /demo-intake.

## 14. Still to verify

- Recount of prompt variables (20 or 21).
- Cloud Scheduler jobs in the live deployment.
- Exact model string before B6.
- Date formats DD/MM/YYYY (F-16).
- Where test screenshots are stored and who sees notes (section 9).
- Whether the old service key has been revoked (F-24).
