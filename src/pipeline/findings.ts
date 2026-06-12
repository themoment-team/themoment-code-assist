/**
 * Inline comment type, submission buffer, and validation (SPEC §4.3 schema,
 * §2 pipeline/findings.ts). The agent submits findings here via the
 * submit_inline_comment tool; nothing is published from this module.
 */
import type { PrDiff, Side } from "../github/diff.js";
import { validatePosition } from "../github/diff.js";

export type Severity = "high" | "medium" | "low";
export type Category = "bug" | "security" | "performance" | "maintainability";

/** A validated inline comment, conforming to the GitHub Review Comment API. */
export interface InlineComment {
  path: string;
  start_line?: number;
  start_side?: Side;
  line: number;
  side: Side;
  severity: Severity;
  category: Category;
  body: string;
  /** optional replacement code, rendered as a GitHub suggestion block */
  suggestion?: string;
  /** rationale / tool evidence — input for the (deferred) critique gate */
  evidence?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface SubmitResult {
  ok: boolean;
  error?: string;
}

/**
 * Accumulates validated inline comments for one review job. Validation happens
 * at submission time; the Publisher re-validates before publishing (§8).
 */
export class FindingsBuffer {
  private readonly items: InlineComment[] = [];

  constructor(private readonly diff: PrDiff) {}

  /** Validate and buffer a comment. Returns a structured error for the agent. */
  submit(c: InlineComment): SubmitResult {
    const posCheck = validatePosition(this.diff, {
      path: c.path,
      line: c.line,
      side: c.side,
      start_line: c.start_line,
      start_side: c.start_side,
    });
    if (!posCheck.ok) return { ok: false, error: posCheck.reason };

    // Suggestions only make sense on a RIGHT-only (new code) single-side range.
    if (c.suggestion !== undefined && c.suggestion !== "") {
      const startSide = c.start_side ?? c.side;
      if (c.side !== "RIGHT" || startSide !== "RIGHT") {
        return { ok: false, error: "suggestion is only allowed on a RIGHT-only range" };
      }
    }

    if (!c.body || c.body.trim() === "") {
      return { ok: false, error: "body must not be empty" };
    }

    // Deduplicate exact (path, line, side) collisions to limit noise.
    const dup = this.items.find(
      (x) => x.path === c.path && x.line === c.line && x.side === c.side && x.body === c.body,
    );
    if (dup) return { ok: true };

    this.items.push(c);
    return { ok: true };
  }

  get size(): number {
    return this.items.length;
  }

  /** Comments sorted by severity (high first), as a fresh array. */
  sortedBySeverity(): InlineComment[] {
    return [...this.items].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    );
  }

  all(): InlineComment[] {
    return [...this.items];
  }
}
