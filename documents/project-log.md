# Project log

## Version 0.3 - documents for parallel build (2026-10-23)

- Source: MyDoctor, commit b91ca9d. No code changes.
- Spec updated to 0.3: step 0 now produces stubs, fakes and failing tests, so branches run in parallel.
- Decisions recorded from Dedi's answers. Open items listed in decisions.md.
- Tests added: T-12 to T-17.
- Tests run: none. Documents only.
- Approval: pending from the project owner (Dedi). Code work starts only after approval.
## 2026-10-23 - repo

- Private repo created: Dedi-automation/Whatsapp-bot-base (main).
- Commit 5b9594a: documents v0.3 and CLAUDE.md. No code.

## 2026-10-23 - step 0 (contracts, stubs, failing tests) - branch step0/contracts

- Scope: interfaces (JSDoc), stubs that throw NotImplementedError, fakes for B3, B5, B6, failing tests for B1, B2, B3, B4, B5, B6, B7, B8, B9, B12, B13. B10 and B11 not started (postponed).
- Stack choice (not in spec, to confirm): plain Node.js CommonJS, no dependencies, tests with `node --test`. package.json has `engines.node >=18`.
- Fakes: `src/fakes/memory-storage.js` (B3), `src/fakes/whatsapp-fake.js` (B5), `src/fakes/ai-fake.js` (B6). Other modules are pure or take injected dependencies, so they have no separate fake.
- Tests run: `npm test` (`node --test "test/**/*.test.js"`). Result: 64 tests. 7 pass (in-memory fake only). 55 fail with NotImplementedError (the stubs). 2 todo (T-09, T-10: need later branches).
- Test IDs covered: T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-11, T-12, T-13, T-14, T-16, T-17. T-08 and F-15, F-16 are covered in B9. T-15 is not testable at step 0. T-09 and T-10 are todo.
- Open choices to confirm before step 1:
  - Send window ends at 17:50 (tested as exclusive: 17:50 is outside). Spec says "09:00 to 17:50".
  - Admin and job token header: `Authorization: Bearer <token>` (proposed in spec 12/13; header name not decided).
  - Config variables added beyond spec Appendix A: AI_MODEL (value TO VERIFY), FIRESTORE_PROJECT_ID (name proposed, decisions.md Open), HEALTH_CHECK_PHONE (optional, F-17).
  - Archive config (`archive.startDate`, `archive.eligibleStatuses`) is a placeholder. Verify against MyDoctor archive.js.
  - Transcript stored one record per message (collection `messages`), to avoid the single-cell limit (F-27).
- Committed as 2dde135 on step0/contracts. Not pushed.
- package.json test script changed to `node --test "test/**/*.test.js"` (quoted glob, so subfolders such as test/fakes are included).

## 2026-10-23 - send window boundary (step 0 follow-up, branch step0/contracts)

- Send window is Sunday to Thursday, 09:00 to 17:50 Israel time, inclusive. Nothing is sent after 17:50 on any day. Decided (decisions.md, item 17). Spec sections 1, 8 and 11 (B8) updated.
- T-04 tests changed: 17:50 is inside, 17:51 is outside. Test IDs kept.
- Fixed a wrong assertion in the step 0 timezone test: 08:00Z was expected outside the window, but it is 11:00 in Israel (inside). The test now uses a summer date (IDT, UTC+3) and a helper that builds Israel wall-clock times, so DST does not change the result.
- Tests after the change: 64 tests. 7 pass, 55 fail (stubs), 2 todo. Unchanged.
- Decisions recorded (decisions.md, items 17 to 20): model string `claude-haiku-5-5`, archive rules per bot, transcript one record per message, retention per bot. The model Open item is closed.
- Not committed.
## 2026-10-23 - step 0 merged

- Merged step0/contracts into main (fast-forward) at 14c1ca4 and pushed to origin.
- Tests: 64 total, 7 pass, 55 fail (stubs), 2 todo.
- Next: step 1 branches A (data), C (AI), D (scheduling).
## 2026-10-26 - step 1, branch C (AI) - branch-c/ai, PR #2

- Scope: B6 AI client, `src/ai.js`, `test/ai.test.js`. Branch commit 23c3b59.
- Findings closed: F-10 (missing variable is an explicit error; model from config only) and F-29 (code side: no empty value reaches the prompt). The F-10 recount of 20/21 variables and the prompt content of F-29 stay per bot.
- Tests: T-06, T-07, T-14. `node --test test/ai.test.js`: 16 tests, 16 pass (6 step-0 + 10 added).
- `npm test` on the branch: 74 tests, 23 pass, 49 fail, 2 todo. Before: 64 / 7 / 55 / 2. All 49 failures are other modules' step-0 stubs.
- Branch dry run: pass (logging fetch, nothing sent). T-09 full DRY RUN deferred to step 2.
- Decided by Dedi (2026-10-26): a whitespace-only prompt value counts as missing (stricter than the step-0 JSDoc); default `max_tokens` is 1024.
- Merged into main at 07734a8 (merge commit, approved by Dedi). `npm test` on main after merge: 74 tests, 23 pass, 49 fail (other branches' stubs), 2 todo. `test/ai.test.js`: 16/16 pass.
- Rollback: revert merge commit 07734a8 (`git revert -m 1 07734a8`); it touches only `src/ai.js` and `test/ai.test.js`.
- Next: branch D (scheduling) rebases on main and merges.
## 2026-10-26 - step 1, branch D (Scheduling) - branch-d/scheduling, PR #3

- Scope: B8 send window `src/schedule-window.js`, B9 jobs `src/jobs.js`, B13 archive `src/archive.js`, and their tests. Branch commits df3a482, e631ed3.
- Findings closed: F-06 (job lock via storage.createIfAbsent; outbound campaign sending is a later module), F-15 (reminders read every record), F-16 (DD/MM/YYYY parsed explicitly, impossible dates are SchemaError), F-17 (archive part: start date and statuses from config).
- Tests: T-04, T-08. Own files: 29 tests, 29 pass (13 step-0 + 16 added), also with TZ set to Asia/Jerusalem, UTC, America/New_York and Pacific/Kiritimati.
- `npm test` on the branch before rebase: 80 tests, 36 pass, 42 fail, 2 todo. After rebase on main d242090: 90 / 52 / 36 / 2. All failures are other modules' step-0 stubs.
- Branch dry run (memory fake, nothing sent): reminders reach both agents' leads; a second run the same day and two parallel runs send nothing twice; 17:51, Friday and a holiday send nothing; archive moves 1 then 0. Same output after the rebase. T-09 full DRY RUN deferred to step 2.
- Decided by Dedi (2026-10-26): `archive.startDate` is the bot's go-live (production) date, set in config at launch; reminder date field is `callbackDate`; dates are always generated automatically, so a malformed date raises SchemaError naming the record.
- Open: MyDoctor-style 3-stage "no reply" reminders (Dedi asked to follow the MyDoctor pattern; follow-up PR after Dedi confirms); archive age/status rule as in MyDoctor archive.js (72 quiet hours for finished leads, 30 days inactive).
- Merged into main at 7bd5f41 (merge commit, by Dedi). `npm test` on main after merge: 90 tests, 52 pass, 36 fail (other branches' stubs), 2 todo.
- Rollback: revert merge commit 7bd5f41 (`git revert -m 1 7bd5f41`); it touches only branch D's six files.
- Next: branch A (data) rebases on main and merges.
## 2026-10-26 - step 1, branch A (Data) - branch-a/data, PR #4

- Scope: B4 schema `src/schema.js`, B3 Firestore storage `src/storage.js`, `test/schema.test.js`, `test/storage.test.js`, `package.json` + lockfile (`@google-cloud/firestore@^8.7.1`; 9.x needs Node 22, the repo allows Node >= 18; new script `test:firestore`). Branch commits f431721, 91a037c.
- Findings closed: F-07 (header check at startup: leading/trailing spaces, empty and duplicate headers fail; every missing required header is listed), F-12 (fields resolved by ID via `headerFor`, never by position; callers must use it).
- Storage: one Firestore project per `projectId` (T-05), atomic `createIfAbsent` via Firestore `create()`, every backend error is a `StorageError` naming the path but never field values, `/` in a collection or record ID is rejected.
- Tests: T-05, T-11, T-12. Own files: 38 tests (18 step-0 + 20 added). Firestore cases run against the Firestore emulator; without `FIRESTORE_EMULATOR_HOST` they are reported as skipped ("not run"), never as passed. `npm run test:firestore` refuses to run without the variable.
- Emulator run on Dedi's machine (Windows 10, Node v26.7.0, gcloud 590.0.1, Java 21, emulator 127.0.0.1:8080), head 91a037c: `npm run test:firestore` 26/26 pass, 0 skipped; `npm test` 109 tests, 84 pass, 23 fail (branch B and E stubs), 0 skipped, 2 todo.
- Bug found during the runs and fixed in 91a037c: with the variable set but the emulator stopped, a file-level cleanup hook failed every test in `storage.test.js` (58 pass, 48 fail). Cleanup is now its own ordered test with a "not reachable ... Is it running?" message, and only the Firestore cases fail.
- Branch dry run (no network): real Firestore client builds, doc path `leads/c1`, an invalid path is rejected before any network call. T-09 full DRY RUN deferred to step 2.
- Decided by Dedi (2026-10-26): env var names `FIRESTORE_PROJECT_ID`, `FIRESTORE_EMULATOR_HOST`, `GOOGLE_APPLICATION_CREDENTIALS` (closes the decisions.md Open item on Firestore variable names); one Firestore project per bot (one agent may run several bots; similar bots run for different agents); without the emulator the Firestore tests are "not run", and they must run with the emulator before merge.
- Merged into main at 015346e (merge commit, by Dedi). `npm test` on main after merge, no emulator: 109 tests, 76 pass, 23 fail (branch B and E stubs), 8 skipped (Firestore emulator cases), 2 todo. `test/schema.test.js` + `test/storage.test.js`: 30 pass, 0 fail, 8 skipped.
- Rollback: revert merge commit 015346e (`git revert -m 1 015346e`); it touches only branch A's files, package.json and package-lock.json.
- Next: branch E (testing) rebases on main and merges, then branch B.
## 2026-10-26 - step 1, branch E (Testing) - branch-e/testing, PR #5

- Scope: B12 health check `src/health.js`, section 9 test mode (new `src/test-mode.js`), `test/health.test.js` (tests added only), new `test/test-mode.test.js`. No shared file, no dependency. Branch commits after rebase on 7209694: ec18d59, 7ea9be8, e186723, 4380151, a099c31, bcf4a94.
- Health check: storage probe (write, read back, delete), AI client presence check with no model call, and a real WhatsApp result message on every run to `config.healthCheck.phone`. On any failure a copy goes to `config.healthCheck.alertPhone` (HEALTH_CHECK_ALERT_PHONE, added to config by branch B). Each check is guarded by a timeout; failures are reported, never thrown.
- Test mode: ends a trial with 4 to 6 fixed per-bot questions, one at a time, then a closing text. Each answer is an improvement record (`improvements/${trialId}:${seq}`). Screenshots and media are saved with the notes; the file is stored base64 in `media` via branch B's `downloadMedia` (cap 700 KiB, reference and reason kept otherwise). Send window honoured for test-mode messages, with resume of a pending question.
- Recommendations: after a closed trial, the AI client gets the prompt, that trial's transcript and notes, and proposes prompt changes saved as `pending_approval` in `recommendations`. Only the owner approves or rejects; nothing edits the prompt automatically.
- Findings closed: F-17 (health part). F-23 narrowed (one trial per AI call, owner approval), not closed. T-10 covered in `test/test-mode.test.js`; the T-10 todo in `test/conversation.test.js` is switched on in step 2.
- Decided by Dedi (2026-10-26):
  - Test screenshots and media are stored in the database and shown in the agent's dashboard (closes the decisions.md Open item on screenshots and who sees notes).
  - Feedback questions are fixed per-bot text from config.
  - Feedback and conversations produce prompt recommendations that the owner approves manually, as in MyDoctor (answers the decisions.md Open item on improvement-review.js: kept, inside test mode).
  - Every health check sends a real WhatsApp message to a configurable number (test number now; clerk or client in production). On failure a copy goes to the owner.
  - Health alerts to the owner ignore the send window. Per-client recipients and timing are set at go-live.
- Tests: own files 42/42 pass. Full run history (20 runs, with rollback points) is in the PR #5 body. Branch dry run (fakes only, nothing real sent): healthy and failing health check, alert copy, full trial with a screenshot, one recommendation; pass. T-09 full DRY RUN deferred to step 2.
- Merged into main at c907c5e (merge commit, by Dedi). `npm test` on main after merge, no emulator: 148 tests, 118 pass, 20 fail (branch B stubs), 8 skipped (Firestore emulator cases), 2 todo. `test/health.test.js` + `test/test-mode.test.js`: 42 pass, 0 fail. Branch E dry run on main: pass.
- Rollback: revert merge commit c907c5e (`git revert -m 1 c907c5e`); it touches only branch E's four files.
- Next: branch B (WhatsApp and entry, PR #1) rebases on main and merges. Then step 2 integration.
## 2026-10-26 - step 1, branch B (WhatsApp and entry) - branch-b/whatsapp, PR #1

- Scope: B1 config `src/config.js`, B2 security `src/security.js`, B5 WhatsApp client `src/whatsapp.js`, B7 conversation engine `src/conversation.js`, HTTP entry `src/server.js` and `src/index.js` (`createBot`), their tests (`test/server.test.js` new), dry run script `scripts/dry-run-branch-b.js`, and `documents/decisions.md` items 21 to 37 (all step 1 decisions). Branch head 57b92fa on main e608b0f.
- Findings closed: F-14 (B1), F-04 for token handling (B2 and job routes), F-20 (B5), F-26 (no /test-sheet route), F-27 (B7, one record per message).
- Tests: T-01, T-02, T-03, T-06 (engine side), T-11, T-13, T-16, T-17. Own files: 57 tests (config 7, security 11, whatsapp 10, conversation 18, server 11), all pass.
- Contract additions: `WhatsAppClient.downloadMedia`, `IncomingMessage.media`, `Config.healthCheck.alertPhone` (HEALTH_CHECK_ALERT_PHONE), engine deps `acceptedMediaTypes`, `mediaReceivedReplyText`, `mediaRejectedReplyText`, `mediaTypeLabels`, outcomes `media_received` and `media_rejected`.
- Decided by Dedi (2026-10-26): the bot thanks the customer first, then records the handoff; the HTTP server and webhook are built in step 1; the duplicate check runs before the message is saved; each bot sets its accepted media types, and a non-accepted format gets a reply naming the accepted formats.
- Branch dry run (HTTP on a local port, real WhatsApp and AI clients with recording fetch, real send window, in-memory storage; nothing sent): text reply, duplicate, voice note, accepted ID photo, rejected video, forged signature (401), handoff, Friday outside the window, job token in URL (401) and in header (200); pass. 5 messages would have been sent. Full test run history (11 runs) is in the PR #1 body. T-09 full DRY RUN deferred to step 2.
- Merged into main at 8251943 (merge commit, by Dedi). `npm test` on main after merge, no emulator: 185 tests, 175 pass, 0 fail, 8 skipped (Firestore emulator cases), 2 todo (T-09, T-10 in conversation.test.js, switched on in step 2). Branch B dry run on main: pass, same output.
- Rollback: revert merge commit 8251943 (`git revert -m 1 8251943`); it touches only branch B's files and decisions.md.
- Decided by Dedi (2026-10-26): B10 (email) and B11 (admin dashboard) move to step 2, rebuilt from MyDoctor logic with their fixes. decisions.md item 38; spec.md sections 8, 10 and 11 updated.
- Step 1 status: all five branches (A, B, C, D, E) are on main. Remaining before step 2: one full `npm test` with the Firestore emulator on Dedi's machine (decisions.md item 23).
- Next: step 2 integration. B7 routes test-mode trials to `testMode.handleMedia` and `testMode.handleAnswer` (branch E note).
