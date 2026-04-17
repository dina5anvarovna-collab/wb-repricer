import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { ensureRuntimeDirs, runtimePaths } from "./lib/runtimePaths.js";

async function main(): Promise<void> {
  ensureRuntimeDirs();
  const app = Fastify({ logger: false });
  const corsList = env.REPRICER_CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: corsList.length > 0 ? corsList : true,
    methods: ["GET", "HEAD", "OPTIONS"],
  });

  const webDist = runtimePaths.webDistDir;
  const publicRoot = runtimePaths.publicDir;
  const root = fs.existsSync(webDist) ? webDist : publicRoot;
  await app.register(fastifyStatic, { root, prefix: "/" });

  app.get("/health", async () => ({
    ok: true,
    ts: new Date().toISOString(),
    mode: "web",
    root,
  }));

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT, root }, "web server started");

  const close = async () => {
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch((e) => {
  logger.error(e, "web server fatal");
  process.exit(1);
});
