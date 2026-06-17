/**
 * pi-ai provider/model registry (SPEC §5, ARCHITECTURE §5).
 *
 * The model backend never penetrates the architecture: every phase resolves to
 * a pi-ai `Model` built from config, and a thin `streamFn`/`complete` wrapper
 * injects the per-phase API key. Swapping local <-> commercial is config-only.
 */
import {
  type AssistantMessage,
  type Context,
  type Model,
  completeSimple,
  streamSimple,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Config, ModelConfig, Phase } from "../config.js";

/**
 * Build a pi-ai `Model` for an OpenAI-compatible (or other known-api) endpoint
 * from our flat `ModelConfig`. pi-ai keys provider behaviour off `api`/`baseUrl`.
 */
export function buildModel(mc: ModelConfig): Model<any> {
  return {
    id: mc.model,
    name: mc.model,
    api: mc.api as any,
    provider: "custom" as any,
    baseUrl: mc.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: mc.contextWindow,
    maxTokens: mc.maxTokens,
  };
}

/** A model bound together with the key/options needed to call it. */
export interface PhaseBackend {
  model: Model<any>;
  apiKey: string;
  /** streamFn for the pi Agent — injects this phase's apiKey into every call. */
  streamFn: StreamFn;
  /** One-shot completion (summary, reply). Returns the final assistant message. */
  complete(context: Context, signal?: AbortSignal): Promise<AssistantMessage>;
}

export function backendFor(config: Config, phase: Phase): PhaseBackend {
  const mc = config.models[phase] ?? config.models.default;
  const model = buildModel(mc);
  const apiKey = mc.apiKey;

  // The agent loop calls streamFn with options that include `apiKey: undefined`
  // (it resolves via getApiKey/config.apiKey, neither of which we set). Spread
  // options FIRST so our per-phase apiKey always wins — otherwise the undefined
  // clobbers it and the provider throws "No API key for provider: custom".
  const streamFn: StreamFn = (m, ctx, options) =>
    streamSimple(m, ctx, { ...options, apiKey });

  return {
    model,
    apiKey,
    streamFn,
    complete: (context, signal) =>
      completeSimple(model, context, { apiKey, maxTokens: mc.maxTokens, signal }),
  };
}
