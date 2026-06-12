/**
 * Per-PR budget enforcement (SPEC §4.3 dual termination, §9, ARCHITECTURE §7).
 *
 * Budget exceeded is not an error — it is "finalize with results so far". The
 * agent's afterToolCall hook consults `check()` and returns { terminate: true }
 * once any limit is hit.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { Logger } from "../logger.js";

export interface BudgetLimits {
  maxIterations: number;
  maxTokens: number;
  timeoutMs: number;
}

export class Budget {
  private iterations = 0;
  private tokens = 0;
  private readonly deadline: number;
  private terminated = false;
  private terminationReason?: string;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly logger: Logger,
  ) {
    this.deadline = Date.now() + limits.timeoutMs;
  }

  /** Record token usage reported by a completed assistant turn. */
  addUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.tokens += usage.totalTokens ?? usage.input + usage.output;
  }

  /** Count one tool-call iteration. */
  private bump(): void {
    this.iterations++;
  }

  /**
   * Called from afterToolCall. Returns true when the agent should stop after the
   * current tool batch.
   */
  check(): boolean {
    this.bump();
    const reason = this.exceededReason();
    if (reason && !this.terminated) {
      this.terminated = true;
      this.terminationReason = reason;
      this.logger.info("budget reached, finalizing", {
        reason,
        iterations: this.iterations,
        tokens: this.tokens,
      });
    }
    return this.terminated;
  }

  private exceededReason(): string | undefined {
    if (this.iterations >= this.limits.maxIterations) return "max_iterations";
    if (this.tokens >= this.limits.maxTokens) return "max_tokens";
    if (Date.now() >= this.deadline) return "timeout";
    return undefined;
  }

  get stats(): { iterations: number; tokens: number; terminated: boolean; reason?: string } {
    return {
      iterations: this.iterations,
      tokens: this.tokens,
      terminated: this.terminated,
      reason: this.terminationReason,
    };
  }
}
