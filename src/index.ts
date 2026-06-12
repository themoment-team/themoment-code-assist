/**
 * Bootstrap (SPEC §2 index.ts): load config, start server & queue, register
 * webhooks. Single-instance, stateless, in-process queue (D9).
 */
import { loadDotenv } from "./env.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { GitHubApp } from "./github/app.js";
import { JobQueue } from "./queue/jobqueue.js";
import { registerWebhooks } from "./github/webhooks.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();

  const app = new GitHubApp(config);
  const queue = new JobQueue(config, logger);
  registerWebhooks({ app, queue, config, logger });

  const server = buildServer({ app, config, logger });
  await server.listen({ port: config.server.port, host: config.server.host });
  logger.info("server listening", {
    port: config.server.port,
    host: config.server.host,
    outputLanguage: config.outputLanguage,
    maxConcurrentReviews: config.limits.maxConcurrentReviews,
  });

  const shutdown = async (sig: string) => {
    logger.info("shutting down", { sig });
    try {
      await server.close();
      await queue.shutdown();
    } catch (err) {
      logger.error("shutdown error", { err: String(err) });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal startup error", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
