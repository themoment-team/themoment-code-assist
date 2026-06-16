/**
 * Context Assembler (SPEC §4.2, ARCHITECTURE §3.3). Deterministic preprocessing
 * before any LLM call: collect PR metadata + diff, check out the head commit,
 * and load the repo's review_guide.md.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { GitHubApp } from "../github/app.js";
import { type Checkout, checkoutPrHead } from "../github/checkout.js";
import { type PrDiff, collectPrDiff } from "../github/diff.js";
import type { PrMeta } from "./prompts.js";

export interface AssembledContext {
  meta: PrMeta;
  diff: PrDiff;
  checkout: Checkout;
  reviewGuide?: string;
  /** PR head commit SHA — the commit_id the review is anchored to. */
  headSha: string;
}

const REVIEW_GUIDE_PATH = ".review/review_guide.md";

export async function assembleContext(opts: {
  app: GitHubApp;
  octokit: Octokit;
  installationId: number;
  config: Config;
  owner: string;
  repo: string;
  pull_number: number;
  logger: Logger;
}): Promise<AssembledContext> {
  const { app, octokit, installationId, config, owner, repo, pull_number, logger } = opts;

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });

  const meta: PrMeta = {
    owner,
    repo,
    number: pull_number,
    title: pr.title ?? "",
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    baseBranch: pr.base?.ref ?? "",
    headBranch: pr.head?.ref ?? "",
    labels: (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
  };

  const diff = await collectPrDiff(octokit, owner, repo, pull_number);
  logger.info("diff collected", {
    files: diff.files.length,
    additions: diff.totalAdditions,
    deletions: diff.totalDeletions,
    truncated: diff.truncated,
  });

  const token = await app.installationToken(installationId);
  const checkout = await checkoutPrHead({
    baseDir: config.checkoutDir,
    owner,
    repo,
    headSha: pr.head.sha,
    token,
    logger,
  });

  const reviewGuide = await loadReviewGuide(checkout.dir, logger);

  return { meta, diff, checkout, reviewGuide, headSha: pr.head.sha };
}

/** Read .review/review_guide.md from the checkout root if present (SPEC §4.2, D11). */
async function loadReviewGuide(dir: string, logger: Logger): Promise<string | undefined> {
  try {
    const content = await readFile(join(dir, REVIEW_GUIDE_PATH), "utf8");
    logger.info("review guide loaded", { bytes: content.length });
    return content;
  } catch {
    return undefined;
  }
}
