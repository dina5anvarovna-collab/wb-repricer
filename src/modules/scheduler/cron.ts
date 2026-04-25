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
import { runFloorProtectionBatch } from "../floorProtection/floorEngine.js";
import { getActiveCabinetToken } from "../catalogSync/syncCatalog.js";
import { prisma } from "../../lib/prisma.js";

const MONITOR_TICK_MS = 60_000;

function catalogSyncHourlyEnabled(): boolean {
  const t = env.REPRICER_CRON_CATALOG_SYNC_HOURLY.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(t);
}

function floorProtectionEnabled(): boolean {
  const t = env.REPRICER_FLOOR_ENABLED.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(t);
}

function floorDryRun(): boolean {
  const t = env.REPRICER_FLOOR_DRY_RUN.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(t);
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
        const ok = await acquireSchedulerLock("monitor");
        if (!ok) {
          logger.warn({ tag: "monitor_skipped_lock_active" }, "scheduled monitor skip — lock held");
          return;
        }
        try {
          await runPriceMonitorJob({ workerId: "scheduled-cron", maxProducts: 100 });
          await setMonitorLastTickAt(new Date());
        } catch (e) {
          logger.error(e, "scheduled monitor failed");
        } finally {
          await releaseSchedulerLock("monitor");
        }
      })();
    }, MONITOR_TICK_MS);
    logger.info({ tickSec: MONITOR_TICK_MS / 1000 }, "scheduler started (monitor by MONITOR_INTERVAL_HOURS)");
  }

  const enforceExpr = env.REPRICER_CRON_ENFORCE.trim();
  if (enforceExpr && cron.validate(enforceExpr)) {
    cron.schedule(enforceExpr, async () => {
      const ok = await acquireSchedulerLock("enforce");
      if (!ok) {
        logger.warn({ tag: "enforce_skipped_lock_active" }, "enforce cron skip — lock held");
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
        await releaseSchedulerLock("enforce");
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
      const ok = await acquireSchedulerLock("catalog");
      if (!ok) {
        logger.warn({ tag: "catalog_skipped_lock_active" }, "catalog hourly sync skip — lock held");
        return;
      }
      try {
        const r = await runUnifiedSync("all");
        logger.info({ ok: r.ok, logId: r.logId, upserted: r.upserted }, "scheduled catalog sync (hourly)");
      } catch (e) {
        logger.error(e, "scheduled catalog sync failed");
      } finally {
        await releaseSchedulerLock("catalog");
      }
    });
    logger.info("scheduler: hourly catalog sync enabled (REPRICER_CRON_CATALOG_SYNC_HOURLY)");
  }

  // ─── Floor Protection Engine ────────────────────────────────────────────────
  if (floorProtectionEnabled()) {
    const intervalMin = env.REPRICER_FLOOR_INTERVAL_MIN;
    // Строим cron-выражение из интервала в минутах
    const floorCronExpr =
      intervalMin <= 59
        ? `*/${intervalMin} * * * *`
        : `0 */${Math.round(intervalMin / 60)} * * *`;

    cron.schedule(floorCronExpr, async () => {
      const ok = await acquireSchedulerLock("floor");
      if (!ok) {
        logger.warn({ tag: "floor_skipped_lock_active" }, "floor protection skip — lock held");
        return;
      }

      // Heartbeat: обновляем каждые 30 сек пока работаем
      const heartbeatInterval = setInterval(() => {
        void prisma.schedulerLock.updateMany({
          where: { id: "floor" },
          data: { heartbeatAt: new Date() },
        }).catch(() => undefined);
      }, 30_000);

      try {
        // Берём расшифрованный токен из БД (активный кабинет)
        const cabinetAuth = await getActiveCabinetToken();
        if (!cabinetAuth?.token) {
          logger.warn({ tag: "floor_no_token" }, "floor protection: нет активного seller token");
          return;
        }

        const result = await runFloorProtectionBatch(cabinetAuth.token, {
          dryRun: floorDryRun(),
          bufferPct: env.REPRICER_FLOOR_BUFFER_PCT,
          maxStepPct: env.REPRICER_FLOOR_MAX_STEP_PCT,
          postVerifyDelayMs: env.REPRICER_FLOOR_POST_VERIFY_DELAY_MIN * 60_000,
          destListOverride: env.REPRICER_FLOOR_DEST_LIST || undefined,
        });

        logger.info(
          { tag: "floor_batch_done", ...result, dryRun: floorDryRun() },
          "floor protection batch completed",
        );
      } catch (e) {
        logger.error(e, "floor protection batch failed");
      } finally {
        clearInterval(heartbeatInterval);
        await releaseSchedulerLock("floor");
      }
    });

    logger.info(
      { floorCronExpr, intervalMin, dryRun: floorDryRun() },
      "scheduler: floor protection engine enabled",
    );
  }
}
