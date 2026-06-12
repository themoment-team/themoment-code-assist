/**
 * Review Orchestrator (SPEC §4.3, §3.1, ARCHITECTURE §2). Runs the one-shot
 * summary call and the single PR agent in parallel, aggregates results, and
 * hands off to the Publisher for one atomic review. Cleans up the checkout.
 */
import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { GitHubApp } from "../github/app.js";
import { renderAnnotatedDiff, renderDiffStats } from "../github/diff.js";
import { publishReview } from "../github/publisher.js";
import { backendFor } from "../llm/models.js";
import { runReviewAgent } from "../agent/session.js";
import { assembleContext } from "./assembler.js";
import { FindingsBuffer } from "./findings.js";
import { generateSummary } from "./summary.js";
import { buildReviewSystemPrompt, buildReviewUserMessage } from "./prompts.js";

export interface ReviewRequest {
  app: GitHubApp;
  octokit: Octokit;
  installationId: number;
  config: Config;
  owner: string;
  repo: string;
  pull_number: number;
  signal: AbortSignal;
  logger: Logger;
}

/** Run the full review pipeline for one PR and publish the result. */
export async function runReviewPipeline(req: ReviewRequest): Promise<void> {
  const { app, octokit, installationId, config, owner, repo, pull_number, signal, logger } = req;

  const ctx = await assembleContext({
    app,
    octokit,
    installationId,
    config,
    owner,
    repo,
    pull_number,
    logger,
  });

  try {
    if (signal.aborted) throw new AbortError();

    const buffer = new FindingsBuffer(ctx.diff);
    const summaryBackend = backendFor(config, "summary");
    const reviewBackend = backendFor(config, "review");

    // Annotated diff for the agent (truncated to budget; falls back to stats).
    const budgetChars = config.limits.maxDiffTokens * 4;
    const annotated = renderAnnotatedDiff(ctx.diff, budgetChars);
    const agentDiff = annotated.length <= budgetChars ? annotated : renderDiffStats(ctx.diff);

    const systemPrompt = buildReviewSystemPrompt({
      language: config.outputLanguage,
      reviewGuide: ctx.reviewGuide,
    });
    const userMessage = buildReviewUserMessage(ctx.meta, agentDiff);

    // Parallel: summary one-shot + PR agent (SPEC §4.3, D15).
    const [summaryResult, agentResult] = await Promise.allSettled([
      generateSummary({
        config,
        backend: summaryBackend,
        meta: ctx.meta,
        diff: ctx.diff,
        reviewGuide: ctx.reviewGuide,
        signal,
      }),
      runReviewAgent({
        config,
        backend: reviewBackend,
        checkoutDir: ctx.checkout.dir,
        buffer,
        systemPrompt,
        userMessage,
        signal,
        logger: logger.child({ phase: "agent" }),
      }),
    ]);

    if (signal.aborted) throw new AbortError();

    // Aggregate. A failure on one path still publishes the other (SPEC §4.5).
    let summary: string;
    let partialFailure: string | undefined;
    if (summaryResult.status === "fulfilled") {
      summary = summaryResult.value;
    } else {
      summary = "_(summary generation failed)_";
      partialFailure = `Summary generation failed: ${errMsg(summaryResult.reason)}`;
      logger.error("summary failed", { err: errMsg(summaryResult.reason) });
    }

    if (agentResult.status === "rejected") {
      logger.error("review agent failed", { err: errMsg(agentResult.reason) });
      const note = `Inline review failed: ${errMsg(agentResult.reason)}`;
      partialFailure = partialFailure ? `${partialFailure}. ${note}` : note;
    }

    // Both phases dead and nothing buffered → surface as a job failure.
    if (summaryResult.status === "rejected" && buffer.size === 0) {
      throw new Error(partialFailure ?? "review pipeline produced no output");
    }

    await publishReview({
      octokit,
      owner,
      repo,
      pull_number,
      commitId: ctx.headSha,
      summary,
      comments: buffer.sortedBySeverity(),
      diff: ctx.diff,
      config,
      logger,
      partialFailure,
    });
  } finally {
    await ctx.checkout.cleanup();
  }
}

export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
