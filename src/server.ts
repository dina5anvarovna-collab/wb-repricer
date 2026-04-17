import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { cleanupExpiredSchedulerLocksOnStartup } from "./lib/schedulerLock.js";
import { ensureRuntimeDirs, runtimePaths } from "./lib/runtimePaths.js";
import { registerAdminAuth } from "./http/adminAuth.js";
import { registerApiRoutes } from "./routes/api.js";
import { startScheduler } from "./modules/scheduler/cron.js";
import { upsertSellerToken } from "./modules/catalogSync/syncCatalog.js";
import {
  healthBrowser,
  healthBuyerSession,
  healthDb,
  healthStorageDirs,
} from "./modules/health/healthChecks.js";

async function main(): Promise<void> {
  if (env.REPRICER_PROCESS_MODE === "worker") {
    throw new Error("REPRICER_PROCESS_MODE=worker: use dist/worker.js entrypoint");
  }
  ensureRuntimeDirs();
  const apiEnabled = env.REPRICER_PROCESS_MODE === "all" || env.REPRICER_PROCESS_MODE === "api";
  const webEnabled = env.REPRICER_PROCESS_MODE === "all" || env.REPRICER_PROCESS_MODE === "web";
  const schedulerEnabled = env.REPRICER_PROCESS_MODE === "all";
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  const corsList = env.REPRICER_CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: corsList.length > 0 ? corsList : true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  });

  registerAdminAuth(app);

  const publicRoot = runtimePaths.publicDir;
  const webDist = runtimePaths.webDistDir;

  if (apiEnabled) {
    await registerApiRoutes(app);
  }

  app.get("/health", async () => ({
    ok: true,
    ts: new Date().toISOString(),
    env: env.NODE_ENV,
    mode: env.REPRICER_PROCESS_MODE,
    apiEnabled,
    webEnabled,
    schedulerEnabled,
  }));
  app.get("/health/db", async () => healthDb());
  app.get("/health/browser", async () => healthBrowser());
  app.get("/health/buyer-session", async () => healthBuyerSession());
  app.get("/health/storage", async () => healthStorageDirs());

  if (webEnabled && fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
    });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  } else if (webEnabled) {
    logger.warn(
      { webDist },
      "apps/web/dist отсутствует — в браузере откроется только public/ (старый лендинг). Выполните: npm run build:web или npm run build:all",
    );
    await app.register(fastifyStatic, {
      root: publicRoot,
      prefix: "/",
    });
  } else {
    app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: "not found" }));
  }

  const close = async () => {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await prisma.$connect();
  await cleanupExpiredSchedulerLocksOnStartup();
  if (env.WB_API_TOKEN.trim()) {
    try {
      await upsertSellerToken(env.WB_API_TOKEN, "env");
      logger.info("seller token bootstrapped from WB_API_TOKEN");
    } catch (e) {
      logger.error(e, "failed to bootstrap WB_API_TOKEN");
    }
  }
  await app.listen({ host: env.HOST, port: env.PORT });
  const ui =
    webEnabled
      ? fs.existsSync(webDist)
        ? env.REPRICER_WEB_DIST_DIR
        : env.REPRICER_PUBLIC_DIR
      : "disabled";
  const openHost = env.HOST === "0.0.0.0" || env.HOST === "::" ? "127.0.0.1" : env.HOST;
  logger.info(
    {
      host: env.HOST,
      port: env.PORT,
      ui,
      mode: env.REPRICER_PROCESS_MODE,
      open: `http://${openHost}:${env.PORT}/`,
      health: `http://${openHost}:${env.PORT}/health`,
      hint:
        env.HOST === "0.0.0.0"
          ? "Слушаем 0.0.0.0 — откройте http://127.0.0.1:PORT или localhost:PORT; Vite dev: npm run dev:web (прокси /api → этот порт)."
          : undefined,
    },
    "repricer server listening — откройте open в браузере (не file://). UI из " + ui,
  );
  if (schedulerEnabled) {
    startScheduler();
  } else {
    logger.info({ mode: env.REPRICER_PROCESS_MODE }, "scheduler disabled for this process mode");
  }
}

main().catch((e) => {
  logger.error(e, "fatal");
  process.exit(1);
});
