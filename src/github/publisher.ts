/**
 * Publisher (SPEC §4.5, ARCHITECTURE §3.7). Re-validates inline comments against
 * the commentable line set, sorts by severity, applies the per-PR limit, and
 * publishes summary(body) + inline comments as ONE atomic COMMENT review.
 *
 * The LLM never reaches this layer — publishing is deterministic and is the only
 * component that calls the GitHub Reviews API (§8).
 */
import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { InlineComment } from "../pipeline/findings.js";
import { type PrDiff, validatePosition } from "./diff.js";

export interface PublishInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  pull_number: number;
  commitId: string;
  summary: string;
  comments: InlineComment[];
  diff: PrDiff;
  config: Config;
  logger: Logger;
  /** Optional note about a partial failure (e.g. summary failed) to append. */
  partialFailure?: string;
}

interface ReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

const SEVERITY_LABEL: Record<string, string> = { high: "🔴", medium: "🟡", low: "🔵" };

export async function publishReview(input: PublishInput): Promise<void> {
  const { octokit, owner, repo, pull_number, commitId, comments, diff, config, logger } = input;

  // Re-validate every position immediately before publishing (defense-in-depth
  // against changes between submission and publish — prevents 422s).
  const valid: InlineComment[] = [];
  const demoted: InlineComment[] = [];
  for (const c of comments) {
    const check = validatePosition(diff, {
      path: c.path,
      line: c.line,
      side: c.side,
      start_line: c.start_line,
      start_side: c.start_side,
    });
    if (check.ok) valid.push(c);
    else {
      demoted.push(c);
      logger.warn("comment dropped at publish-time validation", {
        path: c.path,
        line: c.line,
        reason: check.reason,
      });
    }
  }

  // Sort by severity, then apply the per-PR cap.
  const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  valid.sort((a, b) => rank[b.severity] - rank[a.severity]);
  const limit = config.limits.maxInlineComments;
  const published = valid.slice(0, limit);
  const omittedByLimit = valid.length - published.length;

  const reviewComments: ReviewComment[] = published.map((c) => ({
    path: c.path,
    line: c.line,
    side: c.side,
    start_line: c.start_line,
    start_side: c.start_side,
    body: renderCommentBody(c),
  }));

  const body = renderReviewBody(input, {
    publishedCount: published.length,
    omittedByLimit,
    demoted,
  });

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    commit_id: commitId,
    event: "COMMENT",
    body,
    comments: reviewComments,
  });

  logger.info("review published", {
    inline: reviewComments.length,
    omittedByLimit,
    demoted: demoted.length,
  });
}

/** Render a single inline comment body, with optional suggestion block. */
function renderCommentBody(c: InlineComment): string {
  const tag = `${SEVERITY_LABEL[c.severity] ?? ""} **${c.severity}/${c.category}**`;
  let out = `${tag}\n\n${c.body.trim()}`;
  if (c.suggestion !== undefined && c.suggestion !== "") {
    out += `\n\n\`\`\`suggestion\n${c.suggestion.replace(/\n$/, "")}\n\`\`\``;
  }
  return out;
}

/** Assemble the review body: summary + deterministic finding statistics. */
function renderReviewBody(
  input: PublishInput,
  stats: { publishedCount: number; omittedByLimit: number; demoted: InlineComment[] },
): string {
  const parts: string[] = [input.summary.trim()];

  const footerBits: string[] = [`${stats.publishedCount} inline comment(s)`];
  if (stats.omittedByLimit > 0) footerBits.push(`${stats.omittedByLimit} omitted (limit)`);
  if (stats.demoted.length > 0) footerBits.push(`${stats.demoted.length} could not be anchored`);

  // Surface demoted (un-anchorable) findings inline in the body so they aren't lost.
  if (stats.demoted.length > 0) {
    const lines = stats.demoted
      .slice(0, 10)
      .map((c) => `- \`${c.path}:${c.side}${c.line}\` (${c.severity}/${c.category}) ${c.body.trim().split("\n")[0]}`);
    parts.push(`#### Unanchored findings\n${lines.join("\n")}`);
  }

  if (input.partialFailure) {
    parts.push(`> ⚠️ ${input.partialFailure}`);
  }

  parts.push(`\n---\n_${footerBits.join(" · ")}_`);
  return parts.join("\n\n");
}

/** Post a single failure-notice comment on the PR (SPEC §4.5 failure handling). */
export async function postFailureComment(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  issue_number: number;
  reason: string;
  logger: Logger;
}): Promise<void> {
  const { octokit, owner, repo, issue_number, reason, logger } = opts;
  try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number,
      body: `⚠️ Auto-review failed: ${reason}. Retry with \`/review\`.`,
    });
  } catch (e) {
    logger.error("failed to post failure comment", { err: String(e) });
  }
}
