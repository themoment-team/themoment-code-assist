/**
 * One-shot summary generation (SPEC §4.3 (1), §2 pipeline/summary.ts).
 * A single LLM call over PR metadata + diff → review body markdown. No tools.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { PhaseBackend } from "../llm/models.js";
import type { PrDiff } from "../github/diff.js";
import { renderAnnotatedDiff, renderDiffStats } from "../github/diff.js";
import {
  type PrMeta,
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
} from "./prompts.js";

/** Extract concatenated text from an assistant message. */
export function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

export async function generateSummary(opts: {
  config: Config;
  backend: PhaseBackend;
  meta: PrMeta;
  diff: PrDiff;
  reviewGuide?: string;
  signal: AbortSignal;
}): Promise<string> {
  const { config, backend, meta, diff, reviewGuide, signal } = opts;

  // Use the full annotated diff when it fits the budget; otherwise per-file stats.
  const budgetChars = config.limits.maxDiffTokens * 4; // rough chars-per-token
  const full = renderAnnotatedDiff(diff, budgetChars);
  const diffText = full.length <= budgetChars ? full : renderDiffStats(diff);

  const system = buildSummarySystemPrompt({ language: config.outputLanguage, reviewGuide });
  const user = buildSummaryUserMessage(meta, diffText);

  const result = await backend.complete(
    {
      systemPrompt: system,
      messages: [{ role: "user", content: user, timestamp: Date.now() }],
    },
    signal,
  );

  if (result.stopReason === "error") {
    throw new Error(`summary generation failed: ${result.errorMessage ?? "unknown error"}`);
  }
  return assistantText(result) || "_(summary unavailable)_";
}
