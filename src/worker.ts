import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { cleanupExpiredSchedulerLocksOnStartup } from "./lib/schedulerLock.js";
import { ensureRuntimeDirs } from "./lib/runtimePaths.js";
import { startScheduler } from "./modules/scheduler/cron.js";
import { upsertSellerToken } from "./modules/catalogSync/syncCatalog.js";

async function main(): Promise<void> {
  ensureRuntimeDirs();
  await prisma.$connect();
  await cleanupExpiredSchedulerLocksOnStartup();
  if (env.WB_API_TOKEN.trim()) {
    try {
      await upsertSellerToken(env.WB_API_TOKEN, "env");
      logger.info("worker: seller token bootstrapped from WB_API_TOKEN");
    } catch (e) {
      logger.error(e, "worker: failed to bootstrap WB_API_TOKEN");
    }
  }
  startScheduler();
  logger.info(
    {
      mode: "worker",
      disableCronMonitor: env.REPRICER_DISABLE_CRON_MONITOR,
      enforceCron: env.REPRICER_CRON_ENFORCE,
      dryRun: env.REPRICER_ENFORCE_CRON_DRY_RUN,
    },
    "repricer worker started",
  );
}

async function shutdown(sig: string): Promise<void> {
  logger.info({ sig }, "worker stopping");
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((e) => {
  logger.error(e, "worker fatal");
  process.exit(1);
});
