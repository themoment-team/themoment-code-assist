/**
 * pi Agent integration — single agent per PR (SPEC §4.4, ARCHITECTURE §3.5).
 *
 * Wires the read-only toolset + submit_inline_comment, a tool whitelist
 * (defense-in-depth), and budget enforcement, then runs one prompt to natural
 * completion or budget/abort termination. Inline comments accumulate in the
 * shared FindingsBuffer via the submit tool; this module publishes nothing.
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { PhaseBackend } from "../llm/models.js";
import type { FindingsBuffer } from "../pipeline/findings.js";
import { Budget } from "./budget.js";
import { createReadFileTool } from "./tools/read_file.js";
import { createSearchTool } from "./tools/search.js";
import { createGitBlameTool } from "./tools/git_blame.js";
import { createSubmitCommentTool } from "./tools/submit_comment.js";

const ALLOWED_TOOLS = new Set([
  "read_file",
  "search",
  "git_blame",
  "submit_inline_comment",
]);

export interface RunAgentInput {
  config: Config;
  backend: PhaseBackend;
  checkoutDir: string;
  buffer: FindingsBuffer;
  systemPrompt: string;
  userMessage: string;
  signal: AbortSignal;
  logger: Logger;
}

export interface RunAgentResult {
  iterations: number;
  tokens: number;
  terminatedByBudget: boolean;
  reason?: string;
}

export async function runReviewAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { config, backend, checkoutDir, buffer, systemPrompt, userMessage, signal, logger } = input;

  const budget = new Budget(
    {
      maxIterations: config.limits.maxLoopIterations,
      maxTokens: config.limits.maxLoopTokens,
      timeoutMs: config.limits.jobTimeoutMs,
    },
    logger,
  );

  const tools = [
    createReadFileTool(checkoutDir),
    createSearchTool(checkoutDir),
    createGitBlameTool(checkoutDir),
    createSubmitCommentTool(buffer),
  ];

  logger.info("review agent starting", {
    tools: tools.map((t) => t.name),
    thinkingLevel: config.thinkingLevel,
    model: backend.model.id,
    limits: {
      maxIterations: config.limits.maxLoopIterations,
      maxTokens: config.limits.maxLoopTokens,
      timeoutMs: config.limits.jobTimeoutMs,
    },
  });

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: backend.model,
      thinkingLevel: config.thinkingLevel,
      tools,
      messages: [],
    },
    streamFn: backend.streamFn,
    toolExecution: "parallel",
    // Tool whitelist (defense-in-depth): write/edit/bash are never registered,
    // but block anything off-list explicitly anyway (SPEC §4.4, §8).
    beforeToolCall: async (ctx) =>
      ALLOWED_TOOLS.has(ctx.toolCall.name)
        ? undefined
        : { block: true, reason: `tool not allowed: ${ctx.toolCall.name}` },
    // Budget enforcement + observability.
    afterToolCall: async (ctx) => {
      const terminate = budget.check();
      const logFields: Record<string, unknown> = {
        tool: ctx.toolCall.name,
        isError: ctx.isError,
        findingsSoFar: buffer.size,
        terminate,
      };
      // For submit_inline_comment, surface accept/reject from the tool result details.
      if (ctx.toolCall.name === "submit_inline_comment") {
        const details = ctx.result.details as { accepted?: boolean } | undefined;
        logFields.accepted = details?.accepted;
        if (!details?.accepted) {
          const content = ctx.result.content[0];
          logFields.rejection = content && "text" in content ? content.text : "(no message)";
        }
      }
      logger.info("tool call", logFields);
      return terminate ? { terminate: true } : undefined;
    },
  });

  // Track token usage and surface a tool-call trace for observability (§9).
  agent.subscribe((event) => {
    if (event.type === "turn_end") {
      const msg = event.message as any;
      if (msg.role === "assistant") {
        budget.addUsage(msg.usage);
        const toolCallCount = Array.isArray(msg.content)
          ? msg.content.filter((c: any) => c.type === "toolCall").length
          : 0;
        if (toolCallCount === 0) {
          logger.info("agent turn: text-only response (no tool calls)", {
            findingsSoFar: buffer.size,
            stopReason: msg.stopReason,
          });
        }
      }
    }
    // Log the full assistant message content at debug level for diagnosis.
    if (event.type === "message_end") {
      const msg = event.message as any;
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text as string)
          .join("");
        const toolCalls = msg.content
          .filter((c: any) => c.type === "toolCall")
          .map((c: any) => ({ name: c.name, args: c.arguments }));
        logger.debug("agent message", {
          stopReason: msg.stopReason,
          toolCallCount: toolCalls.length,
          toolCalls,
          text,
        });
      }
    }
    if (event.type === "tool_execution_start") {
      logger.info("tool exec start", { tool: event.toolName, args: event.args });
    }
  });

  // Wire external cancellation (job timeout / debounce restart) to the agent.
  const onAbort = () => agent.abort();
  if (signal.aborted) agent.abort();
  else signal.addEventListener("abort", onAbort, { once: true });

  try {
    await agent.prompt(userMessage);
    await agent.waitForIdle();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  // pi-agent-core swallows stream errors: it records them on state.errorMessage
  // and resolves normally (agent.js handleRunFailure) rather than throwing. If
  // the run failed for a reason other than our own cancellation, surface it as a
  // rejection so the orchestrator logs it and marks a partial failure (SPEC §4.5).
  if (agent.state.errorMessage && !signal.aborted) {
    throw new Error(`review agent stream failed: ${agent.state.errorMessage}`);
  }

  const stats = budget.stats;
  logger.info("review agent finished", {
    iterations: stats.iterations,
    tokens: stats.tokens,
    findings: buffer.size,
    terminatedByBudget: stats.terminated,
    reason: stats.reason,
  });

  return {
    iterations: stats.iterations,
    tokens: stats.tokens,
    terminatedByBudget: stats.terminated,
    reason: stats.reason,
  };
}
