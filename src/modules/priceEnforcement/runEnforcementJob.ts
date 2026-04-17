import type { PriceSnapshot } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { regionLabelForDest } from "../../lib/wbRegions.js";
import { getSelectedRegionDests } from "../../lib/monitorPrefs.js";
import { writeAuditLog } from "../../lib/auditLog.js";
import { isEmergencyStop, isGlobalPaused } from "../../lib/appSettings.js";
import { getActiveCabinetToken } from "../catalogSync/syncCatalog.js";
import {
  THRESHOLD_DECREASE,
  THRESHOLD_PROTECTIVE,
  allowsAutomaticPriceDecrease,
  allowsProtectiveAction,
} from "../../lib/repricingGuards.js";
import {
  fetchGoodsPriceByNmId,
  uploadGoodsPricesTask,
  WbSellerApiError,
} from "../wbSellerApi/client.js";
import { computeProtectionRaise, type RoundingMode } from "../priceProtection/engine.js";
import { ReasonCode } from "../priceProtection/reasonCodes.js";

const BATCH_PAUSE_MS = 650;

const ROUNDING: RoundingMode[] = [
  "integer",
  "tens",
  "end9",
  "end49",
  "end90",
  "end99",
];

const SNAPSHOT_MAX_AGE_H = 24;

function parseSnapshotDetailJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseRounding(mode: string | null | undefined): RoundingMode {
  return ROUNDING.includes(mode as RoundingMode) ? (mode as RoundingMode) : "integer";
}

/** 0..1 из снимка мониторинга */
export function snapshotNumericConfidence(s: PriceSnapshot): number {
  if (s.parseConfidence != null && Number.isFinite(s.parseConfidence)) {
    return Math.max(0, Math.min(1, s.parseConfidence));
  }
  const dj = parseSnapshotDetailJson(s.detailJson);
  const c = dj.confidence as string | undefined;
  if (c === "HIGH") return 1;
  if (c === "MEDIUM") return 0.7;
  if (c === "LOW") return 0.3;
  return 0;
}

function expectedFinalRub(base: number, discountPct: number): number {
  const d = discountPct;
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(d) || d <= 0 || d >= 100) return base;
  return Math.round(base * ((100 - d) / 100));
}

/**
 * Enforcement использует только снимки мониторинга из БД (без live DOM).
 */
export async function runEnforcementJob(opts: {
  workerId: string;
  maxProducts?: number;
  dryRun: boolean;
  toleranceRub: number;
  maxPriceStepPercent: number;
  regionDest: string | null;
  regionLabel: string | null;
}): Promise<{
  jobId: string;
  processed: number;
  corrections: number;
  skipped: number;
  dryRun: boolean;
}> {
  if (await isGlobalPaused()) {
    throw new Error("GLOBAL_PAUSE: защита цен отключена в настройках");
  }
  if (await isEmergencyStop()) {
    throw new Error("EMERGENCY_STOP: аварийная остановка в настройках");
  }

  const rawMax = opts.maxProducts ?? 40;
  const max =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.min(Math.floor(rawMax), 500)
      : 40;

  const auth = await getActiveCabinetToken();
  if (!auth) {
    throw new Error("seller token not configured");
  }

  const job = await prisma.syncJob.create({
    data: {
      type: "enforce",
      status: "running",
      meta: JSON.stringify({
        workerId: opts.workerId,
        dryRun: opts.dryRun,
        toleranceRub: opts.toleranceRub,
        maxPriceStepPercent: opts.maxPriceStepPercent,
        regionDest: opts.regionDest,
        regionLabel: opts.regionLabel,
        source: "db_snapshots_only",
      }),
    },
  });

  let corrections = 0;
  let skipped = 0;

  try {
    const selectedRegionDests = await getSelectedRegionDests();

    const products = await prisma.wbProduct.findMany({
      where: { isActive: true, buyerParseEnabled: true },
      take: max,
      orderBy: { updatedAt: "desc" },
      include: {
        fixedPrices: { orderBy: { effectiveFrom: "desc" }, take: 1 },
        minPriceRule: true,
      },
    });

    let processed = 0;
    for (const p of products) {
      let mr = p.minPriceRule;
      if (!mr && p.fixedPrices[0]) {
        mr = await prisma.minPriceRule.upsert({
          where: { productId: p.id },
          create: {
            productId: p.id,
            minAllowedFinalPrice: p.fixedPrices[0].targetPrice,
          },
          update: {},
        });
      }
      if (!mr) {
        skipped += 1;
        continue;
      }
      const minAllowed = mr.minAllowedFinalPrice;
      if (!mr.controlEnabled) {
        skipped += 1;
        continue;
      }

      const destFilter =
        selectedRegionDests.length > 0
          ? selectedRegionDests
          : opts.regionDest
            ? [opts.regionDest]
            : [];

      const latestPerDest: PriceSnapshot[] = [];
      if (destFilter.length > 0) {
        for (const d of destFilter) {
          const dest = d.trim();
          const snap = await prisma.priceSnapshot.findFirst({
            where: { productId: p.id, regionDest: dest },
            orderBy: [{ parsedAt: "desc" }, { id: "desc" }],
          });
          if (snap) latestPerDest.push(snap);
        }
      } else {
        const snap = await prisma.priceSnapshot.findFirst({
          where: { productId: p.id },
          orderBy: [{ parsedAt: "desc" }, { id: "desc" }],
        });
        if (snap) latestPerDest.push(snap);
      }

      if (latestPerDest.length === 0) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            nmId: p.nmId,
            finalAction: "skipped_no_fresh_wallet_data",
            reason: "no_price_snapshots",
            minimumAllowed: minAllowed,
            safeModeHold: p.safeModeHold,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      const newest = new Date(
        Math.max(...latestPerDest.map((s) => s.parsedAt.getTime())),
      );
      const snapshotAgeH = (Date.now() - newest.getTime()) / 3_600_000;
      if (snapshotAgeH > SNAPSHOT_MAX_AGE_H) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            nmId: p.nmId,
            finalAction: "skipped_no_fresh_wallet_data",
            reason: `snapshot_age_${snapshotAgeH.toFixed(1)}h_gt_${SNAPSHOT_MAX_AGE_H}h`,
            minimumAllowed: minAllowed,
            safeModeHold: p.safeModeHold,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      const wallets = latestPerDest
        .map((s) => s.buyerWalletPrice)
        .filter((x): x is number => x != null && Number.isFinite(x) && x > 0);
      if (wallets.length === 0) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            nmId: p.nmId,
            finalAction: "skipped_no_fresh_wallet_data",
            reason: "no_wallet_rub_in_snapshots",
            minimumAllowed: minAllowed,
            safeModeHold: p.safeModeHold,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      const observedWallet = Math.min(...wallets);
      const confidences = latestPerDest.map(snapshotNumericConfidence);
      const numericConf = Math.min(...confidences);

      const enforceDest = opts.regionDest?.trim() ?? "";
      const primarySnap =
        enforceDest.length > 0
          ? latestPerDest.find((s) => (s.regionDest ?? "").trim() === enforceDest) ?? latestPerDest[0]
          : latestPerDest[0];
      const observedRegular = primarySnap?.buyerRegularPrice ?? null;

      if (!allowsProtectiveAction(numericConf)) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            nmId: p.nmId,
            finalAction: "skipped_low_confidence",
            confidence: numericConf,
            thresholdProtective: THRESHOLD_PROTECTIVE,
            minimumAllowed: minAllowed,
            oldPriceCabinetRub: null,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      let cab: { nmID: number; price: number; discount: number };
      try {
        const row = await fetchGoodsPriceByNmId(auth.token, p.nmId);
        if (!row) {
          await prisma.cabinetPriceUpload.create({
            data: {
              productId: p.id,
              nmId: p.nmId,
              previousPriceRub: p.sellerPrice,
              newPriceRub: p.sellerPrice ?? 0,
              discountPercent: p.sellerDiscount ?? 0,
              targetPriceRub: minAllowed,
              observedWalletRub: observedWallet,
              observedRegularRub: observedRegular,
              regionDest: opts.regionDest,
              regionLabel: opts.regionLabel,
              dryRun: opts.dryRun,
              status: "failed",
              errorMessage: "nmId не найден в WB prices API",
              syncJobId: job.id,
            },
          });
          await writeAuditLog({
            action: "protection.skip",
            entityType: "WbProduct",
            entityId: p.id,
            dryRun: opts.dryRun,
            meta: {
              nmId: p.nmId,
              finalAction: "skipped_seller_api_mismatch",
              reason: "nm_not_found",
            },
          });
          skipped += 1;
          processed += 1;
          await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
          continue;
        }
        cab = row;
      } catch (e) {
        const msg = e instanceof WbSellerApiError ? e.message : String(e);
        await writeAuditLog({
          action: "protection.api_error",
          entityType: "WbProduct",
          entityId: p.id,
          meta: { nmId: p.nmId, error: msg.slice(0, 500) },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      let minutesSince: number | null = null;
      if (mr.lastSuccessfulRaiseAt) {
        minutesSince = (Date.now() - mr.lastSuccessfulRaiseAt.getTime()) / 60_000;
      }

      const eng = computeProtectionRaise({
        minAllowedFinalPrice: minAllowed,
        currentBasePrice: cab.price,
        currentDiscountPercent: cab.discount,
        observedWalletPrice: observedWallet,
        observedDiscountedPrice: p.discountedPriceRub,
        safetyBufferPercent: mr.safetyBufferPercent,
        roundingMode: parseRounding(mr.roundingMode),
        maxIncreasePercentPerCycle: Math.min(
          opts.maxPriceStepPercent,
          mr.maxIncreasePercentPerCycle,
        ),
        maxIncreaseAbsolute: mr.maxIncreaseAbsolute,
        minChangeThreshold: mr.minChangeThreshold,
        minutesSinceLastRaise: minutesSince,
        cooldownMinutes: mr.cooldownMinutes,
        priceToleranceRub: opts.toleranceRub,
        enforcementMode: true,
        walletParseConfidence: numericConf,
        minWalletConfidence: Math.min(THRESHOLD_PROTECTIVE, env.REPRICER_MIN_WALLET_PARSE_CONFIDENCE),
      });

      const hardSafetyBlockers: string[] = [];

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const updatesToday = await prisma.cabinetPriceUpload.count({
        where: {
          productId: p.id,
          dryRun: false,
          status: "submitted",
          createdAt: { gte: startOfDay },
        },
      });
      if (updatesToday >= env.REPRICER_MAX_UPDATES_PER_DAY_PER_SKU) {
        hardSafetyBlockers.push("max_updates_per_day_reached");
      }

      if (destFilter.length > 0) {
        let validRegionsCount = 0;
        for (const d of destFilter) {
          const snap = latestPerDest.find((x) => (x.regionDest ?? "").trim() === d.trim());
          if (!snap) continue;
          if (snapshotNumericConfidence(snap) >= THRESHOLD_PROTECTIVE && snap.buyerWalletPrice != null && snap.buyerWalletPrice > 0) {
            validRegionsCount += 1;
          }
        }
        if (validRegionsCount < Math.min(env.REPRICER_MIN_VALID_REGIONS_FOR_ENFORCE, destFilter.length)) {
          hardSafetyBlockers.push("insufficient_valid_regions");
        }
      }

      if (opts.regionDest) {
        const recentRegion = await prisma.priceSnapshot.findMany({
          where: { productId: p.id, regionDest: opts.regionDest },
          orderBy: [{ parsedAt: "desc" }, { id: "desc" }],
          take: 3,
          select: { buyerWalletPrice: true },
        });
        const vals = recentRegion
          .map((x) => (x.buyerWalletPrice != null && x.buyerWalletPrice > 0 ? x.buyerWalletPrice : null))
          .filter((x): x is number => x != null);
        if (vals.length >= 2) {
          const mx = Math.max(...vals);
          const mn = Math.min(...vals);
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          const spreadPct = avg > 0 ? ((mx - mn) / avg) * 100 : 0;
          if (spreadPct > env.REPRICER_REGION_STABILITY_MAX_SPREAD_PCT) {
            hardSafetyBlockers.push("region_price_unstable");
          }
        }
      }

      await prisma.minPriceRule.update({
        where: { productId: p.id },
        data: {
          lastCheckAt: new Date(),
          lastReasonCode: eng.reasonCode,
          lastEvaluationSummary: eng.reason.slice(0, 500),
        },
      });

      const auditBase = {
        nmId: p.nmId,
        oldPriceRub: cab.price,
        proposedPriceRub: eng.newBasePrice ?? null,
        minimumAllowed: minAllowed,
        source: "db_price_snapshots",
        confidence: numericConf,
        safeModeHold: p.safeModeHold,
        parseSourceHint: parseSnapshotDetailJson(primarySnap.detailJson).priceParseSource ?? null,
        thresholdDecrease: THRESHOLD_DECREASE,
        thresholdProtective: THRESHOLD_PROTECTIVE,
      };

      if (eng.action === "no_change" || eng.action === "skip") {
        const skipNoWallet =
          eng.reasonCode === ReasonCode.SKIPPED_NO_WALLET ||
          eng.reasonCode === ReasonCode.SKIPPED_LOW_CONFIDENCE ||
          eng.reasonCode === ReasonCode.SKIPPED_NO_OBSERVED_FINAL;
        if (eng.action === "skip" && skipNoWallet) {
          await prisma.cabinetPriceUpload.create({
            data: {
              productId: p.id,
              nmId: p.nmId,
              previousPriceRub: cab.price,
              newPriceRub: cab.price,
              discountPercent: cab.discount,
              targetPriceRub: minAllowed,
              observedWalletRub: observedWallet,
              observedRegularRub: observedRegular,
              regionDest: opts.regionDest,
              regionLabel: opts.regionLabel,
              dryRun: opts.dryRun,
              status: "failed",
              errorMessage: eng.reason,
              reasonCode: eng.reasonCode,
              engineDetailJson: JSON.stringify({
                formulaLog: eng.formulaLog,
                flags: eng.safetyFlags,
              }),
              parseConfidence: numericConf,
              syncJobId: job.id,
            },
          });
        }
        const fa =
          eng.reasonCode === ReasonCode.SKIPPED_LOW_CONFIDENCE
            ? "skipped_low_confidence"
            : eng.reasonCode === ReasonCode.SKIPPED_NO_WALLET
              ? "skipped_no_fresh_wallet_data"
              : `skipped_${eng.reasonCode}`;
        await writeAuditLog({
          action: `protection.${eng.action}`,
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            ...auditBase,
            finalAction: fa,
            reason: eng.reason,
            observedFinal: eng.observedFinalPrice,
            flags: eng.safetyFlags,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      const proposed = eng.newBasePrice!;

      const expectedAfterApply = expectedFinalRub(proposed, cab.discount);
      if (expectedAfterApply < minAllowed - opts.toleranceRub) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            ...auditBase,
            finalAction: "skipped_below_min",
            reason: "blocked_by_min_price_rule",
            expectedAfterApply,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      if (proposed < cab.price) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            ...auditBase,
            finalAction: "skipped_price_decrease_blocked",
            reason: "never_lower_base_without_high_confidence",
            wouldDecrease: true,
            decreaseAllowed: allowsAutomaticPriceDecrease(numericConf),
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      if (proposed === cab.price) {
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      const lastSubmitted = await prisma.cabinetPriceUpload.findFirst({
        where: { productId: p.id, dryRun: false, status: "submitted" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { newPriceRub: true },
      });
      if (lastSubmitted?.newPriceRub != null && lastSubmitted.newPriceRub > 0) {
        const diffPct = Math.abs((proposed - lastSubmitted.newPriceRub) / lastSubmitted.newPriceRub) * 100;
        if (diffPct > env.REPRICER_MAX_PROPOSED_CHANGE_PCT) {
          hardSafetyBlockers.push("proposed_step_anomaly");
        }
      }
      if (hardSafetyBlockers.length > 0) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            ...auditBase,
            proposedPriceRub: proposed,
            finalAction: "skipped_safety_blockers",
            blockedBySafetyRule: hardSafetyBlockers,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      const djPrimary = parseSnapshotDetailJson(primarySnap.detailJson);
      const appliedReason =
        numericConf >= THRESHOLD_DECREASE
          ? djPrimary.priceParseSource === "popup_dom"
            ? "applied_popup_dom_confident"
            : "applied_public_dom_confident"
          : p.walletRubLastGood != null && p.safeModeHold
            ? "applied_protective_raise_last_good"
            : "applied_protective_raise_snapshot";

      if (opts.dryRun) {
        await prisma.cabinetPriceUpload.create({
          data: {
            productId: p.id,
            nmId: p.nmId,
            previousPriceRub: cab.price,
            newPriceRub: proposed,
            discountPercent: cab.discount,
            targetPriceRub: minAllowed,
            observedWalletRub: observedWallet,
            observedRegularRub: observedRegular,
            regionDest: opts.regionDest,
            regionLabel: opts.regionLabel,
            dryRun: true,
            status: "dry_run",
            errorMessage: eng.reason,
            reasonCode: eng.reasonCode,
            engineDetailJson: JSON.stringify({ formulaLog: eng.formulaLog, flags: eng.safetyFlags }),
            parseConfidence: numericConf,
            syncJobId: job.id,
          },
        });
        await writeAuditLog({
          action: "protection.price_raise_dry_run",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: true,
          requestJson: { nmID: cab.nmID, price: proposed, discount: cab.discount },
          meta: {
            ...auditBase,
            proposedPriceRub: proposed,
            finalAction: appliedReason,
            expectedFinal: eng.expectedFinalPrice,
            observedFinal: eng.observedFinalPrice,
          },
        });
        corrections += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      try {
        const uploadRes = await uploadGoodsPricesTask(auth.token, [
          { nmID: cab.nmID, price: proposed, discount: cab.discount },
        ]);
        await prisma.cabinetPriceUpload.create({
          data: {
            productId: p.id,
            nmId: p.nmId,
            previousPriceRub: cab.price,
            newPriceRub: proposed,
            discountPercent: cab.discount,
            targetPriceRub: minAllowed,
            observedWalletRub: observedWallet,
            observedRegularRub: observedRegular,
            regionDest: opts.regionDest,
            regionLabel: opts.regionLabel,
            wbTaskId: uploadRes.id,
            dryRun: false,
            status: "submitted",
            errorMessage: eng.reason,
            reasonCode: ReasonCode.BELOW_MIN_RAISE_SUBMITTED,
            engineDetailJson: JSON.stringify({ formulaLog: eng.formulaLog, flags: eng.safetyFlags }),
            parseConfidence: numericConf,
            syncJobId: job.id,
          },
        });
        await prisma.minPriceRule.update({
          where: { productId: p.id },
          data: {
            lastSuccessfulRaiseAt: new Date(),
            lastCheckAt: new Date(),
            lastReasonCode: ReasonCode.BELOW_MIN_RAISE_SUBMITTED,
            lastEvaluationSummary: eng.reason.slice(0, 500),
          },
        });
        await writeAuditLog({
          action: "protection.price_raise_submitted",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: false,
          requestJson: { nmID: cab.nmID, price: proposed, discount: cab.discount },
          responseJson: uploadRes,
          meta: {
            ...auditBase,
            proposedPriceRub: proposed,
            finalAction: appliedReason,
            expectedFinal: eng.expectedFinalPrice,
            observedFinal: eng.observedFinalPrice,
          },
        });
        corrections += 1;
        logger.info(
          {
            nmId: p.nmId,
            from: cab.price,
            to: proposed,
            taskId: uploadRes.id,
            observed: eng.observedFinalPrice,
            min: minAllowed,
          },
          "cabinet price upload submitted",
        );
      } catch (e) {
        const msg = e instanceof WbSellerApiError ? e.message : String(e);
        await prisma.cabinetPriceUpload.create({
          data: {
            productId: p.id,
            nmId: p.nmId,
            previousPriceRub: cab.price,
            newPriceRub: proposed,
            discountPercent: cab.discount,
            targetPriceRub: minAllowed,
            observedWalletRub: observedWallet,
            observedRegularRub: observedRegular,
            regionDest: opts.regionDest,
            regionLabel: opts.regionLabel,
            dryRun: false,
            status: "failed",
            errorMessage: msg.slice(0, 2000),
            reasonCode: ReasonCode.BELOW_MIN_RAISE_PROPOSED,
            engineDetailJson: JSON.stringify({ formulaLog: eng.formulaLog, uploadError: msg.slice(0, 500) }),
            parseConfidence: numericConf,
            syncJobId: job.id,
          },
        });
        await writeAuditLog({
          action: "protection.price_raise_failed",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: false,
          meta: { error: msg.slice(0, 500), proposed, ...auditBase },
        });
        logger.warn({ nmId: p.nmId, err: msg }, "cabinet price upload failed");
      }

      processed += 1;
      await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    }

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "done", finishedAt: new Date() },
    });
    logger.info({ jobId: job.id, processed, corrections, skipped, dryRun: opts.dryRun }, "enforce job done");
    return { jobId: job.id, processed, corrections, skipped, dryRun: opts.dryRun };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(e, "enforce job failed");
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: msg.slice(0, 2000) },
    });
    throw e;
  }
}

export function resolveWalletRegionOpts(
  destOverride: string | null | undefined,
): { regionDest: string | null; regionLabel: string | null } {
  const d = destOverride?.trim() || null;
  if (!d) {
    return { regionDest: null, regionLabel: null };
  }
  return { regionDest: d, regionLabel: regionLabelForDest(d) };
}
