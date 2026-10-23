# Handoff: WhatsApp bot base (whatsapp-bot-base)

Status: documents only. No code exists yet. Approval from the project owner is pending on the open items in decisions.md.

## Read order for the new chat

1. CLAUDE.md: working rules for Claude Code in the new repo.
2. spec.md: what the base is, the module contracts, the build order and the parallel plan.
3. decisions.md: what is decided, what is proposed, what is open.
4. test-plan.md: the tests every release must pass.
5. project-log.md: version history. Every change is recorded here.

## What to do first

Step 0 (stubs and contracts) comes first, in one session. Everything after it can run in parallel. Do not write module code before step 0 is merged.

## Files in this bundle

- README.md (this file)
- CLAUDE.md
- spec.md
- decisions.md
- test-plan.md
- project-log.md

Copy these into a `documents/` folder in the new repo and commit them. Git is the source of truth. Claude Docs pages are read-only views refreshed from git.
