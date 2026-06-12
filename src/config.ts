/**
 * Configuration loading & schema (SPEC §7).
 *
 * All runtime configuration is sourced from environment variables. Secrets are
 * never logged. Per-phase model overrides fall back to the default model.
 */
import { readFileSync } from "node:fs";

export type Phase = "summary" | "review" | "critique" | "reply";

/** Resolved model backend config for a single phase (SPEC §5). */
export interface ModelConfig {
  api: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
}

export interface Config {
  github: {
    appId: string;
    privateKey: string;
    webhookSecret: string;
  };
  models: {
    default: ModelConfig;
    summary: ModelConfig;
    review: ModelConfig;
    critique: ModelConfig;
    reply: ModelConfig;
  };
  outputLanguage: string;
  limits: {
    maxInlineComments: number;
    maxLoopIterations: number;
    maxLoopTokens: number;
    maxDiffTokens: number;
    maxConcurrentReviews: number;
    jobTimeoutMs: number;
    debounceMs: number;
  };
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  filter: {
    excludedBranches: string[];
    excludedLabels: string[];
  };
  server: {
    port: number;
    host: string;
    logLevel: string;
  };
  checkoutDir: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * GitHub App private keys are PEM blocks. They may be provided inline (with
 * literal `\n` escapes, as is common in CI secret stores) or as a file path.
 */
function loadPrivateKey(): string {
  const path = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (path && path.trim() !== "") {
    return readFileSync(path.trim(), "utf8");
  }
  const inline = req("GITHUB_PRIVATE_KEY");
  return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
}

const defaultModelConfig = (): ModelConfig => ({
  api: process.env.LLM_API?.trim() || "openai-completions",
  baseUrl: req("LLM_BASE_URL"),
  // Local OpenAI-compatible servers often accept any non-empty key.
  apiKey: process.env.LLM_API_KEY?.trim() || "nokey",
  model: req("LLM_MODEL"),
  contextWindow: num("LLM_CONTEXT_WINDOW", 128_000),
  maxTokens: num("LLM_MAX_TOKENS", 8192),
});

/**
 * Per-phase override. The phase var (e.g. `REVIEW_MODEL`) holds the model id;
 * `REVIEW_API` / `REVIEW_BASE_URL` / `REVIEW_API_KEY` override the backend.
 * Any field left unset inherits the default model config.
 */
function phaseModelConfig(prefix: string, base: ModelConfig): ModelConfig {
  const model = process.env[`${prefix}_MODEL`]?.trim();
  if (!model) return base;
  return {
    api: process.env[`${prefix}_API`]?.trim() || base.api,
    baseUrl: process.env[`${prefix}_BASE_URL`]?.trim() || base.baseUrl,
    apiKey: process.env[`${prefix}_API_KEY`]?.trim() || base.apiKey,
    model,
    contextWindow: num(`${prefix}_CONTEXT_WINDOW`, base.contextWindow),
    maxTokens: num(`${prefix}_MAX_TOKENS`, base.maxTokens),
  };
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const defaultModel = defaultModelConfig();

  cached = {
    github: {
      appId: req("GITHUB_APP_ID"),
      privateKey: loadPrivateKey(),
      webhookSecret: req("GITHUB_WEBHOOK_SECRET"),
    },
    models: {
      default: defaultModel,
      summary: phaseModelConfig("SUMMARY", defaultModel),
      review: phaseModelConfig("REVIEW", defaultModel),
      critique: phaseModelConfig("CRITIQUE", defaultModel),
      reply: phaseModelConfig("REPLY", defaultModel),
    },
    outputLanguage: process.env.OUTPUT_LANGUAGE?.trim() || "ko",
    limits: {
      maxInlineComments: num("MAX_INLINE_COMMENTS", 20),
      maxLoopIterations: num("MAX_LOOP_ITERATIONS", 40),
      maxLoopTokens: num("MAX_LOOP_TOKENS", 400_000),
      maxDiffTokens: num("MAX_DIFF_TOKENS", 60_000),
      maxConcurrentReviews: num("MAX_CONCURRENT_REVIEWS", 1),
      jobTimeoutMs: num("JOB_TIMEOUT_MS", 600_000),
      debounceMs: num("DEBOUNCE_MS", 30_000),
    },
    thinkingLevel: (process.env.THINKING_LEVEL?.trim() as Config["thinkingLevel"]) || "medium",
    filter: {
      excludedBranches: list("EXCLUDED_BRANCHES"),
      excludedLabels: list("EXCLUDED_LABELS"),
    },
    server: {
      port: num("PORT", 3000),
      host: process.env.HOST?.trim() || "0.0.0.0",
      logLevel: process.env.LOG_LEVEL?.trim() || "info",
    },
    checkoutDir: process.env.CHECKOUT_DIR?.trim() || ".checkout-cache",
  };

  return cached;
}

/** Test/reset hook. */
export function resetConfigCache(): void {
  cached = undefined;
}
