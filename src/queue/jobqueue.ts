/**
 * Event Filter / Job Queue (SPEC §4.1, ARCHITECTURE §3.2).
 *
 * - Debounce: collapse same-PR bursts within DEBOUNCE_MS, run only the last.
 * - Job uniqueness: one job per PR key; a new job aborts the in-flight one.
 * - Global concurrency: p-queue caps concurrent jobs across PRs.
 * - Volatile: in-flight jobs are lost on restart (recoverable via /review).
 */
import PQueue from "p-queue";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export type JobFactory = (signal: AbortSignal) => Promise<void>;

export class JobQueue {
  private readonly queue: PQueue;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.queue = new PQueue({ concurrency: config.limits.maxConcurrentReviews });
  }

  /**
   * Schedule a job for `key`. Debounced by default; pass immediate=true for
   * command-triggered runs (/review) that shouldn't wait out the window.
   */
  schedule(key: string, factory: JobFactory, immediate = false): void {
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);

    const delay = immediate ? 0 : this.config.limits.debounceMs;
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.run(key, factory);
    }, delay);
    this.pending.set(key, timer);
    this.logger.debug("job scheduled", { key, immediate, delayMs: delay });
  }

  private run(key: string, factory: JobFactory): void {
    // Cancel & restart any in-flight job for the same PR (SPEC §4.1).
    const prev = this.inflight.get(key);
    if (prev) {
      this.logger.info("aborting in-flight job to restart", { key });
      prev.abort();
    }
    const controller = new AbortController();
    this.inflight.set(key, controller);

    void this.queue.add(async () => {
      // A newer job may have superseded this one while it waited in the queue.
      if (this.inflight.get(key) !== controller) return;
      const t0 = Date.now();
      this.logger.info("job started", { key });
      try {
        await factory(controller.signal);
        this.logger.info("job finished", { key, ms: Date.now() - t0 });
      } catch (err) {
        if (controller.signal.aborted) {
          this.logger.info("job aborted", { key });
        } else {
          this.logger.error("job failed", { key, err: String(err) });
        }
      } finally {
        if (this.inflight.get(key) === controller) this.inflight.delete(key);
      }
    });
  }

  /** Drain timers and wait for running jobs (used on shutdown). */
  async shutdown(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const controller of this.inflight.values()) controller.abort();
    await this.queue.onIdle();
  }
}
