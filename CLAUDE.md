# Working rules for whatsapp-bot-base

1. Documents in `documents/` are the source of truth. Read them before any change.
2. Step 0 first: write each module's interface (types, inputs, outputs, errors), a fake implementation, and failing tests. Merge step 0 before any module work starts.
3. One branch (or git worktree) per owner, as listed in spec.md section 10. A branch edits only its own module files. Shared files (interfaces, config schema) change only through step 0 or a reviewed contract change.
4. Every finding in spec.md section 5 that a module owns must be closed by that module, with a test from test-plan.md.
5. Never copy code from MyDoctor line by line. Reuse the logic, rewrite the module to its contract.
6. No secrets in the repo, the documents or the chat. Use environment variables. `.env` stays in `.gitignore`.
7. Nothing is deployed without: all tests passing, a DRY RUN (T-09), and approval from the project owner.
8. Every change is recorded in project-log.md. Every bug found in practice gets a new test ID.
9. Documents and code are written in English.
10. When a question is unclear or depends on a business decision, stop and ask. Do not guess.
