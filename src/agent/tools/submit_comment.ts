/**
 * submit_inline_comment tool (SPEC §4.3 schema, §4.4, ARCHITECTURE §3.5).
 *
 * Immediately validates the submission against the commentable line set and
 * buffers it. It NEVER calls the GitHub API — publishing is the Publisher's
 * sole responsibility (§8). Validation failures are returned as tool results so
 * the agent can correct and resubmit.
 */
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FindingsBuffer, InlineComment } from "../../pipeline/findings.js";
import { textResult } from "./util.js";

const Side = Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]);

const Params = Type.Object({
  path: Type.String({ description: "Repo-relative file path, exactly as it appears in the diff." }),
  start_line: Type.Optional(
    Type.Integer({ minimum: 1, description: "Multi-line range start (optional)." }),
  ),
  start_side: Type.Optional(Side),
  line: Type.Integer({ minimum: 1, description: "Range end, or the single line being commented on." }),
  side: Side,
  severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  category: Type.Union([
    Type.Literal("bug"),
    Type.Literal("security"),
    Type.Literal("performance"),
    Type.Literal("maintainability"),
  ]),
  body: Type.String({ description: "The comment content and rationale." }),
  suggestion: Type.Optional(
    Type.String({
      description: "Optional replacement code (RIGHT-only range). Rendered as a GitHub suggestion.",
    }),
  ),
  evidence: Type.Optional(
    Type.String({ description: "Summary of the tool results that grounded this finding." }),
  ),
});

export function createSubmitCommentTool(buffer: FindingsBuffer): AgentTool<typeof Params> {
  return {
    name: "submit_inline_comment",
    label: "Submit inline comment",
    // Submissions mutate the shared buffer, so keep them sequential.
    executionMode: "sequential",
    description:
      "Submit a single inline review comment anchored to diff lines using L/R notation (side LEFT = old/deleted, RIGHT = new/added). The position is validated immediately against the diff; an error result means you should fix the line/side and resubmit. Comments are buffered, not published.",
    parameters: Params,
    execute: async (_id, params: Static<typeof Params>) => {
      const comment: InlineComment = {
        path: params.path,
        start_line: params.start_line,
        start_side: params.start_side,
        line: params.line,
        side: params.side,
        severity: params.severity,
        category: params.category,
        body: params.body,
        suggestion: params.suggestion,
        evidence: params.evidence,
      };
      const result = buffer.submit(comment);
      if (!result.ok) {
        return textResult(`REJECTED: ${result.error}. Fix the position or content and resubmit.`, {
          accepted: false,
        });
      }
      return textResult(
        `Accepted (${buffer.size} buffered so far): ${params.severity}/${params.category} at ${params.side}${params.line} of ${params.path}.`,
        { accepted: true },
      );
    },
  };
}
