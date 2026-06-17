/**
 * GitHub App authentication (SPEC §6, §2 github/app.ts).
 *
 * Issues installation access tokens via @octokit/app. One installation covers
 * an entire org (and new repos automatically), so we cache an authenticated
 * Octokit per installation id for the token's lifetime.
 */
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";

export class GitHubApp {
  private readonly app: App;
  private readonly cache = new Map<number, { octokit: Octokit; expiresAt: number }>();

  constructor(config: Config) {
    this.app = new App({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      webhooks: { secret: config.github.webhookSecret },
      // Use @octokit/rest's Octokit so installation clients expose REST methods at
      // the top level (octokit.pulls / octokit.issues), matching every call site.
      // The default @octokit/app Octokit only namespaces them under `.rest`.
      Octokit,
    });
  }

  /** The underlying @octokit/app instance (used to mount webhook verification). */
  get octokitApp(): App {
    return this.app;
  }

  /**
   * Returns an Octokit authenticated as the given installation. Cached until a
   * minute before token expiry; @octokit/app handles the JWT -> token exchange.
   */
  async forInstallation(installationId: number): Promise<Octokit> {
    const now = Date.now();
    const hit = this.cache.get(installationId);
    if (hit && hit.expiresAt - 60_000 > now) {
      return hit.octokit;
    }
    const octokit = (await this.app.getInstallationOctokit(installationId)) as Octokit;
    // Installation tokens live ~60 min; refresh conservatively at 50 min.
    this.cache.set(installationId, { octokit, expiresAt: now + 50 * 60_000 });
    return octokit;
  }

  /**
   * Raw installation access token string — needed to authenticate `git clone`
   * for checkout. Scoped to the installation's minimal permissions (SPEC §8).
   */
  async installationToken(installationId: number): Promise<string> {
    const octokit = await this.forInstallation(installationId);
    const auth = (await (octokit as unknown as {
      auth: (opts: { type: string }) => Promise<{ token: string }>;
    }).auth({ type: "installation" }));
    return auth.token;
  }
}
