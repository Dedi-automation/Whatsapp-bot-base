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
