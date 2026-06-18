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
import type { Side } from "../../github/diff.js";
import type { FindingsBuffer, InlineComment, Severity, Category } from "../../pipeline/findings.js";
import { textResult } from "./util.js";

/**
 * String-enum schema that serializes to JSON Schema's `enum` keyword
 * (`{ type: "string", enum: [...] }`). `Type.Union([Type.Literal(...)])` instead
 * emits `anyOf` + `const`, which constrained-decoding backends (llama.cpp / vLLM
 * grammar, engaged here by tool_choice:"required") mishandle: they wrap the value
 * in an extra pair of quotes, so e.g. `side` arrives as `"\"RIGHT\""`. That
 * malformed value fails position validation and traps the agent in an identical-
 * resubmit loop. The `enum` keyword is the well-supported guided-decoding path.
 */
const StringEnum = <T extends string>(values: readonly T[], description?: string) =>
  Type.Unsafe<T>({
    type: "string",
    enum: [...values],
    ...(description !== undefined ? { description } : {}),
  });

const SideSchema = StringEnum<Side>(["LEFT", "RIGHT"], "side LEFT = old/deleted, RIGHT = new/added.");

const Params = Type.Object({
  path: Type.String({ description: "Repo-relative file path, exactly as it appears in the diff." }),
  start_line: Type.Optional(
    Type.Integer({ minimum: 1, description: "Multi-line range start (optional)." }),
  ),
  start_side: Type.Optional(SideSchema),
  line: Type.Integer({ minimum: 1, description: "Range end, or the single line being commented on." }),
  side: SideSchema,
  severity: StringEnum<Severity>(["high", "medium", "low"], "Finding severity."),
  category: StringEnum<Category>(
    ["bug", "security", "performance", "maintainability"],
    "Finding category.",
  ),
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

/**
 * Strip one pair of stray surrounding quotes (and whitespace) that a
 * constrained-decoding backend might still add around an enum value — belt-and-
 * suspenders for the resubmit loop: even if a backend ignores the `enum` schema,
 * `"\"RIGHT\""` is normalized back to `RIGHT` before validation. Valid enum
 * values never contain quotes.
 */
function unquote<T extends string>(value: T): T;
function unquote<T extends string>(value: T | undefined): T | undefined;
function unquote<T extends string>(value: T | undefined): T | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return (t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t) as T;
}

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
        start_side: unquote(params.start_side),
        line: params.line,
        side: unquote(params.side),
        severity: unquote(params.severity),
        category: unquote(params.category),
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
        `Accepted (${buffer.size} buffered so far): ${comment.severity}/${comment.category} at ${comment.side}${comment.line} of ${comment.path}.`,
        { accepted: true },
      );
    },
  };
}
