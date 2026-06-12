# PR Review Bot

A GitHub App that auto-reviews pull requests. For each PR it produces **two
outputs in parallel** and publishes them as a single atomic review:

- **summary** — a one-shot LLM call over PR metadata + diff → the review body.
- **inline comments** — a single [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
  agent per PR that explores the checked-out code with read-only tools and
  submits grounded, line-anchored comments via a structured tool.

This implements milestones **M0–M2** of [`SPEC.md`](./SPEC.md) (the MVP):
the review pipeline plus the `/review` and `/reply-review` commands. Deferred
items (self-critique gate, incremental/idempotent publishing, execution
isolation, agentic reply, subagents) are M3+ and not built yet.

## How it works

```
GitHub ──webhook──▶ Fastify (verify X-Hub-Signature-256, 200)
                        │
                        ▼
              Event Filter / Job Queue   (debounce, 1 job/PR, concurrency)
                        │
              Context Assembler          (metadata + diff + checkout + review_guide.md)
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
   summary (one-shot)            review agent (pi, read-only tools)
        │                                │  submit_inline_comment → validated buffer
        └───────────────┬────────────────┘
                        ▼
                    Publisher            (re-validate, sort, limit, single COMMENT review)
```

- **Auto-review** triggers on `pull_request` `opened` / `reopened` /
  `ready_for_review` only — *not* on every push (`synchronize`). Re-run manually
  with `/review`.
- **Commands** (`/review`, `/reply-review`) require write access or above and
  are ignored otherwise.
- **Stateless**: no database. The job queue/debounce is in-process and volatile;
  a lost in-flight job is recoverable via `/review`.

## Security model

The PR diff is treated as **untrusted input** (prompt injection is possible):

- The agent has **read-only tools only** (`read_file`, `search`, `git_blame`) plus
  `submit_inline_comment`, which only buffers — it never calls the GitHub API.
  `write`/`edit`/`bash` are never registered, and a tool whitelist blocks anything
  off-list as defense-in-depth.
- Every tool confines filesystem access to the checkout root.
- Comment line ranges are validated **twice** — at submission and again in the
  Publisher immediately before posting — against the diff's commentable line set.
- The review event is always `COMMENT`; the bot never approves, requests changes,
  or merges.

> MVP runs on the host under a trusted-internal-org assumption. Per-job container
> isolation (SPEC M5) is required before exposing this to external orgs.

## Setup

### 1. Create a GitHub App

Permissions: **Pull requests** Read & Write, **Contents** Read, **Issues** Read &
Write, **Metadata** Read. Subscribe to events: **Pull request**, **Issue comment**,
**Pull request review comment**. Set the webhook URL to `https://<host>/webhook`
and a webhook secret. Install it on your org/repos.

### 2. Configure

```bash
cp .env.example .env
# fill in GITHUB_APP_ID, GITHUB_PRIVATE_KEY (or _PATH), GITHUB_WEBHOOK_SECRET,
# and the LLM_* backend (any OpenAI-compatible endpoint, local or commercial).
```

Per-phase models (`SUMMARY_MODEL`, `REVIEW_MODEL`, `REPLY_MODEL`, …) are optional
and fall back to the default `LLM_MODEL`. See [`.env.example`](./.env.example) and
[`SPEC.md` §7](./SPEC.md) for every variable.

### 3. Run

```bash
npm install
npm run build
npm start
# or, for development:
npm run dev
```

Docker:

```bash
docker build -t pr-review-bot .
docker run --env-file .env -p 3000:3000 pr-review-bot
```

## Per-repo configuration

If a target repo contains `review/review_guide.md`, its contents are injected
into the review and reply system prompts, so each repo can steer category
weights, focus areas, and conventions.

## Commands

| Command | Where | Effect |
|---|---|---|
| `/review` | PR comment | Manual full re-review (same pipeline as auto-review). |
| `/reply-review` | inline review thread **or** PR comment | The bot replies in context to the discussion (single LLM call). |

## Project layout

```
src/
├─ index.ts            bootstrap
├─ config.ts           env → config schema
├─ env.ts              minimal .env loader
├─ logger.ts           structured logging
├─ server.ts           Fastify + signature verification
├─ github/             app auth, webhooks, checkout, diff, publisher
├─ queue/              p-queue debounce / single-job-per-PR
├─ pipeline/           assembler, orchestrator, summary, findings, prompts
├─ agent/              pi session, budget, read-only tools + submit_inline_comment
├─ commands/           parse + permission, review, reply
└─ llm/                pi-ai model registry (per-phase)
```

## Status / not yet implemented

M3 self-critique gate · M4 incremental + idempotent publishing · M5 execution
isolation · M6 agentic reply · M7 subagent spawn. These have placeholders in the
architecture but are intentionally out of the MVP scope.
