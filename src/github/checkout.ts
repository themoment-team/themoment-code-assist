/**
 * Repo checkout at PR head commit (SPEC §4.2, §2 github/checkout.ts).
 *
 * The agent's read-only tools operate on this on-disk snapshot. MVP uses a full
 * clone so git_blame has history (SPEC §12); optimize to shallow + range fetch
 * later if clone cost matters. The directory is deleted on job completion.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../logger.js";

const exec = promisify(execFile);

export interface Checkout {
  /** Absolute path to the checkout root. All tools confine access to this. */
  dir: string;
  /** Remove the working directory. Safe to call multiple times. */
  cleanup(): Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // Disable interactive credential prompts; auth travels in the remote URL.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const { stdout } = await exec("git", args, {
    cwd,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Clone `owner/repo` at `headSha` into a fresh temp dir under `baseDir`.
 * Authenticated via the installation token embedded in the remote URL.
 */
export async function checkoutPrHead(opts: {
  baseDir: string;
  owner: string;
  repo: string;
  headSha: string;
  token: string;
  logger: Logger;
}): Promise<Checkout> {
  const { baseDir, owner, repo, headSha, token, logger } = opts;

  const absBase = resolve(baseDir);
  if (!existsSync(absBase)) mkdirSync(absBase, { recursive: true });
  const dir = await mkdtemp(join(absBase, `${repo}-`));

  // Token embedded only in the transient remote; redact from any logging.
  const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const t0 = Date.now();
  try {
    await git(dir, ["init", "--quiet"]);
    await git(dir, ["remote", "add", "origin", remote]);
    // Fetch just the head commit's history (full depth for blame accuracy).
    await git(dir, ["fetch", "--quiet", "origin", headSha]);
    await git(dir, ["checkout", "--quiet", headSha]);
    // Strip credentials from the stored remote so later blame/log can't leak it.
    await git(dir, ["remote", "set-url", "origin", `https://github.com/${owner}/${repo}.git`]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  logger.info("checkout complete", { owner, repo, headSha, ms: Date.now() - t0 });

  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch((e) =>
        logger.warn("checkout cleanup failed", { dir, err: String(e) }),
      );
    },
  };
}
