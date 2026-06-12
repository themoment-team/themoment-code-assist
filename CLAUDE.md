# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GitHub PR review bot: webhook → one-shot summary + single pi agent per PR → one atomic review. Node.js + TypeScript, ESM. **`SPEC.md` and `ARCHITECTURE.md` are the source of truth** — consult them before changing behavior; section refs (e.g. `§4.5`, `D13`) appear in file-header comments.

## Commands

- `npm run build` — `tsc` → `dist/`
- `npm run typecheck` — `tsc --noEmit` (the main correctness check; run after changes)
- `npm run dev` — watch-run `src/index.ts` via tsx (no build step)
- `npm start` — run the built `dist/index.js`

There is **no test framework and no linter** configured. Verification is `npm run typecheck` plus manual smoke tests. Don't assume `npm test` exists.

## Hard rules (don't break these)

- **ESM imports need explicit `.js` extensions**, even though the source is `.ts` (NodeNext resolution). Write `import { x } from "./config.js"`, never `"./config"`. Getting this wrong breaks the runtime, not the typecheck.
- **The pi packages are pinned to `0.79.1`** (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`). Their API was built against the installed type defs and is version-specific — don't bump without re-checking signatures.
- Strict TS with `noUnusedLocals`/`noUnusedParameters` on. Match the existing style: 2-space indent, a doc-comment header per file citing the relevant SPEC section.

## Security invariant (the core threat model — §8)

The PR diff is **untrusted input** (prompt injection). Preserve these when touching the agent/tools/publisher:

- The review agent is **read-only**. Only `read_file`, `search`, `git_blame`, `submit_inline_comment` are registered; `write`/`edit`/`bash` must never be added. `beforeToolCall` whitelists tool names as defense-in-depth.
- `submit_inline_comment` **only buffers** — it never calls the GitHub API. Publishing happens exclusively in `github/publisher.ts`.
- Inline comment line ranges are validated **twice**: at submission (`pipeline/findings.ts`) and again before publishing (`github/publisher.ts`), against the commentable line set from `github/diff.ts`.
- Review event is always `COMMENT`. Never `APPROVE`/`REQUEST_CHANGES`/merge.
- Every filesystem tool confines paths to the checkout root via `confinePath` (`agent/tools/util.ts`). New tools must do the same.

## Architecture notes

- **Model backend is config-only** (`llm/models.ts`, `config.ts`): OpenAI-compatible `Model` objects are constructed by hand (not `getModel`), keyed off `api`/`baseUrl`; the per-phase API key is injected via the `streamFn`/`complete` wrappers. Per-phase overrides (`SUMMARY`/`REVIEW`/`CRITIQUE`/`REPLY`) fall back to the default model.
- **Stateless / in-process** (D9): no DB; the job queue + debounce is volatile (`queue/jobqueue.ts`). Lost in-flight jobs are recovered via `/review`.
- **Auto-review fires only on `opened`/`reopened`/`ready_for_review`** — *not* `synchronize` (D4). This is intentional; don't "fix" it.
- Secrets never go to logs; the logger emits structured JSON only with explicit fields.

## Scope

Implemented: **M0–M2** (review pipeline + `/review` + `/reply-review`). **M3–M7 are deferred** (self-critique gate, incremental/idempotent publishing, execution isolation, agentic reply, subagents) — see `STATE.md`. Don't implement deferred milestones unless asked. `STATE.md` tracks current status.
