/**
 * finish_review tool (SPEC §4.4). Called by the agent when it has submitted
 * all findings and wants to stop. Returns terminate:true so the agent loop
 * exits cleanly without waiting for the budget to be exhausted.
 *
 * This tool exists solely to give the model a way to signal completion when
 * tool_choice:"required" forces every turn to produce a tool call.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { textResult } from "./util.js";

const Params = Type.Object({});

export function createFinishReviewTool(): AgentTool<typeof Params> {
  return {
    name: "finish_review",
    label: "Finish review",
    description:
      "Signal that the review is complete. Call this when you have submitted all findings and have nothing more to add. Do not call it before you have reviewed all meaningful changes in the diff.",
    parameters: Params,
    execute: async () => ({
      ...textResult("Review complete. No further tool calls will be made."),
      terminate: true,
    }),
  };
}
