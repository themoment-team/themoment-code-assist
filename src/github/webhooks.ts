/**
 * Webhook event routing → Event Filter → queue/command dispatch
 * (SPEC §3.1-§3.3, §4.1, §4.7, ARCHITECTURE §3.1-§3.2).
 *
 * Auto-review triggers on pull_request opened/reopened/ready_for_review only;
 * synchronize is intentionally excluded (D4). Commands arrive via issue_comment
 * and pull_request_review_comment.
 */
import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { GitHubApp } from "./app.js";
import type { JobQueue } from "../queue/jobqueue.js";
import { scheduleReview } from "../commands/review.js";
import { detectCommand, hasPermission } from "../commands/parse.js";
import { handleInlineThreadReply, handlePrConversationReply } from "../commands/reply.js";

export interface WebhookDeps {
  app: GitHubApp;
  queue: JobQueue;
  config: Config;
  logger: Logger;
}

const AUTO_REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

/** Installation id is present on all GitHub App deliveries but not in every
 * action's static payload type — read it defensively. */
function getInstallationId(payload: unknown): number | undefined {
  return (payload as { installation?: { id?: number } }).installation?.id;
}

export function registerWebhooks(deps: WebhookDeps): void {
  const { app, queue, config, logger } = deps;
  const webhooks = app.octokitApp.webhooks;

  // ── Auto review ──────────────────────────────────────────────────────────
  webhooks.on("pull_request", async ({ payload }) => {
    if (!AUTO_REVIEW_ACTIONS.has(payload.action)) return;
    const installationId = getInstallationId(payload);
    if (!installationId) return;

    const pr = payload.pull_request;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const log = logger.child({ event: "pull_request", action: payload.action, repo, pr: pr.number });

    const skip = filterReason(pr, config);
    if (skip) {
      log.info("auto-review skipped", { reason: skip });
      return;
    }

    log.info("auto-review enqueued");
    scheduleReview({
      app,
      queue,
      config,
      installationId,
      owner,
      repo,
      pull_number: pr.number,
      logger,
      immediate: false,
    });
  });

  // ── PR-level comment commands (/review, /reply-review) ───────────────────
  webhooks.on("issue_comment", async ({ payload }) => {
    if (payload.action !== "created") return;
    if (!payload.issue.pull_request) return; // PR comments only (ignore issues)
    const installationId = getInstallationId(payload);
    if (!installationId) return;

    const comment = payload.comment;
    if (comment.user?.type === "Bot") return; // never trigger on our own comments

    const command = detectCommand(comment.body);
    if (!command) return;

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pull_number = payload.issue.number;
    const log = logger.child({ event: "issue_comment", command, repo, pr: pull_number });

    if (!hasPermission(comment.author_association)) {
      log.info("command rejected: insufficient permission", {
        association: comment.author_association,
      });
      return;
    }

    if (command === "review") {
      log.info("/review enqueued");
      scheduleReview({
        app,
        queue,
        config,
        installationId,
        owner,
        repo,
        pull_number,
        logger,
        immediate: true,
      });
    } else {
      log.info("/reply-review (PR conversation)");
      runDetached(log, async () => {
        const octokit = (await app.forInstallation(installationId)) as Octokit;
        await handlePrConversationReply(
          { octokit, config, owner, repo, pull_number, logger: log },
          comment.id,
        );
      });
    }
  });

  // ── Inline review-comment thread commands (/reply-review) ────────────────
  webhooks.on("pull_request_review_comment", async ({ payload }) => {
    if (payload.action !== "created") return;
    const installationId = getInstallationId(payload);
    if (!installationId) return;

    const comment = payload.comment;
    if (comment.user?.type === "Bot") return;

    const command = detectCommand(comment.body);
    if (command !== "reply-review") return; // /review not meaningful on a thread

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pull_number = payload.pull_request.number;
    const log = logger.child({ event: "review_comment", repo, pr: pull_number });

    if (!hasPermission(comment.author_association)) {
      log.info("command rejected: insufficient permission", {
        association: comment.author_association,
      });
      return;
    }

    log.info("/reply-review (inline thread)");
    runDetached(log, async () => {
      const octokit = (await app.forInstallation(installationId)) as Octokit;
      await handleInlineThreadReply(
        { octokit, config, owner, repo, pull_number, logger: log },
        comment.id,
      );
    });
  });

  webhooks.onError((err) => {
    logger.error("webhook handler error", { err: String(err) });
  });
}

/** Determine whether a PR should be skipped (draft / bot / excluded). */
function filterReason(
  pr: {
    draft?: boolean;
    user?: { type?: string } | null;
    base?: { ref?: string };
    labels?: { name?: string }[];
  },
  config: Config,
): string | undefined {
  if (pr.draft) return "draft";
  if (pr.user?.type === "Bot") return "bot-author";

  const baseRef = pr.base?.ref ?? "";
  if (config.filter.excludedBranches.some((glob) => globMatch(glob, baseRef))) {
    return `excluded-branch:${baseRef}`;
  }
  const labels = (pr.labels ?? []).map((l) => l.name ?? "");
  const hit = config.filter.excludedLabels.find((ex) => labels.includes(ex));
  if (hit) return `excluded-label:${hit}`;

  return undefined;
}

/** Minimal glob matcher supporting `*` wildcards. */
function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(
    "^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(value);
}

/** Run an async command handler without blocking the webhook ack. */
function runDetached(logger: Logger, fn: () => Promise<void>): void {
  fn().catch((err) => logger.error("command handler failed", { err: String(err) }));
}
