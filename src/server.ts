/**
 * Webhook receiver (SPEC §2 server.ts, ARCHITECTURE §3.1). Fastify endpoint
 * that verifies X-Hub-Signature-256 and hands the event to @octokit/webhooks,
 * then returns 200. Handlers only enqueue/dispatch — no heavy work here.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { GitHubApp } from "./github/app.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function buildServer(deps: {
  app: GitHubApp;
  config: Config;
  logger: Logger;
}): FastifyInstance {
  const { app, logger } = deps;
  const fastify = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  // Capture the raw request body so we can verify the HMAC signature against it.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  fastify.get("/healthz", async () => ({ status: "ok" }));

  fastify.post("/webhook", async (request, reply) => {
    const id = request.headers["x-github-delivery"] as string | undefined;
    const name = request.headers["x-github-event"] as string | undefined;
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    const payload = request.body as string;

    if (!id || !name || !signature) {
      return reply.code(400).send({ error: "missing webhook headers" });
    }

    try {
      await app.octokitApp.webhooks.verifyAndReceive({
        id,
        name: name as never,
        signature,
        payload,
      });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      // Signature failures and malformed payloads land here.
      const message = err instanceof Error ? err.message : String(err);
      if (/signature/i.test(message)) {
        logger.warn("webhook signature verification failed", { id });
        return reply.code(401).send({ error: "invalid signature" });
      }
      logger.error("webhook processing error", { id, err: message });
      // The event was authentic; ack so GitHub doesn't redeliver a poisoned event.
      return reply.code(200).send({ ok: true });
    }
  });

  return fastify;
}
