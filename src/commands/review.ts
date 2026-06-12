/**
 * Review scheduling shared by auto-review (§3.1) and the /review command (§3.2,
 * D5). Both run the identical M1 pipeline; /review just schedules immediately.
 */
import type { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { GitHubApp } from "../github/app.js";
import type { JobQueue } from "../queue/jobqueue.js";
import { runReviewPipeline } from "../pipeline/orchestrator.js";
import { postFailureComment } from "../github/publisher.js";

export interface ScheduleReviewOpts {
  app: GitHubApp;
  queue: JobQueue;
  config: Config;
  installationId: number;
  owner: string;
  repo: string;
  pull_number: number;
  logger: Logger;
  /** true for /review (skip debounce), false for auto-review. */
  immediate: boolean;
}

export function jobKey(owner: string, repo: string, pull_number: number): string {
  return `${owner}/${repo}#${pull_number}`;
}

/** Enqueue a full review job for a PR, with failure-comment handling. */
export function scheduleReview(opts: ScheduleReviewOpts): void {
  const { app, queue, config, installationId, owner, repo, pull_number, logger, immediate } = opts;
  const key = jobKey(owner, repo, pull_number);
  const jobLogger = logger.child({ key });

  queue.schedule(
    key,
    async (signal) => {
      const octokit = (await app.forInstallation(installationId)) as Octokit;
      try {
        await runReviewPipeline({
          app,
          octokit,
          installationId,
          config,
          owner,
          repo,
          pull_number,
          signal,
          logger: jobLogger,
        });
      } catch (err) {
        if (signal.aborted) throw err; // superseded — let the queue log it
        const reason = err instanceof Error ? err.message : String(err);
        await postFailureComment({
          octokit,
          owner,
          repo,
          issue_number: pull_number,
          reason,
          logger: jobLogger,
        });
        throw err;
      }
    },
    immediate,
  );
}
