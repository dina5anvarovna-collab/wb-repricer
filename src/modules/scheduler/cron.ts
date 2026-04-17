import cron from "node-cron";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { acquireSchedulerLock, releaseSchedulerLock } from "../../lib/schedulerLock.js";
import {
  getMonitorIntervalHours,
  getMonitorLastTickAt,
  getPrimaryWalletRegion,
  setMonitorLastTickAt,
} from "../../lib/monitorPrefs.js";
import { resolveWalletRegionOpts, runEnforcementJob } from "../priceEnforcement/runEnforcementJob.js";
import { runPriceMonitorJob } from "../priceMonitor/runMonitor.js";
import { runUnifiedSync } from "../wbSync/unifiedSyncService.js";

const MONITOR_TICK_MS = 60_000;

function catalogSyncHourlyEnabled(): boolean {
  const t = env.REPRICER_CRON_CATALOG_SYNC_HOURLY.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(t);
}

function cronMonitorDisabled(): boolean {
  const t = env.REPRICER_DISABLE_CRON_MONITOR.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(t);
}

function enforceCronDryRun(): boolean {
  const t = env.REPRICER_ENFORCE_CRON_DRY_RUN.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(t);
}

export function startScheduler(): void {
  if (cronMonitorDisabled()) {
    logger.info("scheduled monitor disabled (REPRICER_DISABLE_CRON_MONITOR)");
  } else {
    setInterval(() => {
      void (async () => {
        let hours: number;
        try {
          hours = await getMonitorIntervalHours();
        } catch (e) {
          logger.error(e, "monitor interval read failed");
          return;
        }
        const ms = hours * 3600 * 1000;
        const last = await getMonitorLastTickAt();
        const now = Date.now();
        /** Пока не было успешного прогона, плановый мониторинг не стартует — иначе lock занят часами и ручной запуск даёт Conflict. */
        if (last == null) {
          return;
        }
        if (now - last.getTime() < ms) {
          return;
        }
        const ok = await acquireSchedulerLock();
        if (!ok) {
          /* lock занят — уже идёт мониторинг (ручной или этот же процесс); тихо пропускаем тик */
          return;
        }
        try {
          await runPriceMonitorJob({ workerId: "scheduled-cron", maxProducts: 100 });
          await setMonitorLastTickAt(new Date());
        } catch (e) {
          logger.error(e, "scheduled monitor failed");
        } finally {
          await releaseSchedulerLock();
        }
      })();
    }, MONITOR_TICK_MS);
    logger.info({ tickSec: MONITOR_TICK_MS / 1000 }, "scheduler started (monitor by MONITOR_INTERVAL_HOURS)");
  }

  const enforceExpr = env.REPRICER_CRON_ENFORCE.trim();
  if (enforceExpr && cron.validate(enforceExpr)) {
    cron.schedule(enforceExpr, async () => {
      const ok = await acquireSchedulerLock();
      if (!ok) {
        logger.warn("enforce cron skip: lock held");
        return;
      }
      try {
        const primary = await getPrimaryWalletRegion();
        const { regionDest, regionLabel } = resolveWalletRegionOpts(primary.regionDest);
        await runEnforcementJob({
          workerId: "scheduled-enforce-cron",
          maxProducts: 80,
          dryRun: enforceCronDryRun(),
          toleranceRub: env.REPRICER_ENFORCE_TOLERANCE_RUB,
          maxPriceStepPercent: env.REPRICER_ENFORCE_MAX_STEP_PERCENT,
          regionDest,
          regionLabel,
        });
      } catch (e) {
        logger.error(e, "scheduled enforce failed");
      } finally {
        await releaseSchedulerLock();
      }
    });
    logger.info(
      { enforceExpr, enforceCronDryRun: enforceCronDryRun() },
      "scheduler started (enforce prices)",
    );
  } else if (enforceExpr) {
    logger.error({ enforceExpr }, "invalid REPRICER_CRON_ENFORCE — skipped");
  }

  if (catalogSyncHourlyEnabled()) {
    cron.schedule("12 * * * *", async () => {
      const ok = await acquireSchedulerLock();
      if (!ok) {
        logger.warn("catalog hourly sync skip: lock held");
        return;
      }
      try {
        const r = await runUnifiedSync("all");
        logger.info({ ok: r.ok, logId: r.logId, upserted: r.upserted }, "scheduled catalog sync (hourly)");
      } catch (e) {
        logger.error(e, "scheduled catalog sync failed");
      } finally {
        await releaseSchedulerLock();
      }
    });
    logger.info("scheduler: hourly catalog sync enabled (REPRICER_CRON_CATALOG_SYNC_HOURLY)");
  }
}
