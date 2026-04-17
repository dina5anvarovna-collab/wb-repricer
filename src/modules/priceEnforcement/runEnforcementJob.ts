import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { regionLabelForDest } from "../../lib/wbRegions.js";
import { getSelectedRegionDests } from "../../lib/monitorPrefs.js";
import { writeAuditLog } from "../../lib/auditLog.js";
import { isEmergencyStop, isGlobalPaused } from "../../lib/appSettings.js";
import { getActiveCabinetToken, resolveBuyerProfileDir } from "../catalogSync/syncCatalog.js";
import {
  createEphemeralWalletProfileDir,
  removeEphemeralWalletProfileDir,
} from "../../lib/ephemeralWalletProfile.js";
import { isBuyerAuthDisabled } from "../../lib/repricerMode.js";
import { getBuyerDisplayedPrice } from "../wbBuyerDom/runWalletCli.js";
import { resolveObservedBuyerPrices } from "../pricing/resolveObservedBuyerPrices.js";
import {
  aggregateTrustedProductSnapshot,
  buildBuyerRegionalSnapshotFromPriceSnapshot,
  buildBuyerRegionalSnapshotFromResolved,
  buildSellerSnapshotFromProduct,
  evaluateTrustedRepricingDecision,
} from "../pricing/trustedProductSnapshot.js";
import {
  fetchGoodsPriceByNmId,
  uploadGoodsPricesTask,
  WbSellerApiError,
} from "../wbSellerApi/client.js";
import {
  computeProtectionRaise,
  type RoundingMode,
} from "../priceProtection/engine.js";
import { ReasonCode } from "../priceProtection/reasonCodes.js";
import { resolveStockLevel } from "../../lib/stockLevel.js";

const BATCH_PAUSE_MS = 650;

const ROUNDING: RoundingMode[] = [
  "integer",
  "tens",
  "end9",
  "end49",
  "end90",
  "end99",
];

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

/**
 * Защита минимальной итоговой цены: observed mode (кошелёк/DOM + цены кабинета),
 * подъём базовой цены в WB при нарушении min.
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
      }),
    },
  });

  let corrections = 0;
  let skipped = 0;
  let ephemeralProfileDir: string | null = null;

  try {
    const session = isBuyerAuthDisabled()
      ? null
      : await prisma.buyerSession.findFirst({
          where: { status: "active", isAuthorized: true },
          orderBy: { updatedAt: "desc" },
        });
    let profileDir = session?.profileDir ?? resolveBuyerProfileDir();
    if (isBuyerAuthDisabled()) {
      ephemeralProfileDir = createEphemeralWalletProfileDir();
      profileDir = ephemeralProfileDir;
      logger.info(
        { tag: "enforce-public-only", profileDir },
        "public parse — ephemeral browser profile (no buyer auth)",
      );
    }
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

      const dom = await getBuyerDisplayedPrice({
        nmId: p.nmId,
        profileDir,
        regionDest: opts.regionDest,
        fetchShowcaseWithCookies: !isBuyerAuthDisabled(),
      });

      if (p.safeModeHold === true && !dom.success) {
        logger.warn(
          { nmId: p.nmId, tag: "enforce-safe-hold" },
          "enforcement skipped — safe mode hold, live public parse unavailable",
        );
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            nmId: p.nmId,
            reason: "wallet_source_unavailable_safe_hold",
            domError: dom.error ?? null,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

      const stockLevel = resolveStockLevel(p.stock, dom.inStock ?? null);
      const lastRegionSnapshot = await prisma.priceSnapshot.findFirst({
        where: { productId: p.id, regionDest: opts.regionDest },
        orderBy: { parsedAt: "desc" },
        select: { buyerWalletPrice: true, buyerRegularPrice: true },
      });
      const resolved = resolveObservedBuyerPrices({
        dom,
        stockLevel,
        expectedNmId: p.nmId,
        expectedDest: opts.regionDest,
        fallbackContext: {
          discountedPriceRub: p.discountedPriceRub,
          targetRub: minAllowed,
          sellerPrice: p.sellerPrice,
          lastSnapshotWalletRub: lastRegionSnapshot?.buyerWalletPrice ?? null,
          lastSnapshotRegularRub: lastRegionSnapshot?.buyerRegularPrice ?? null,
          lastKnownShowcaseRub: p.lastKnownShowcaseRub,
          lastKnownWalletRub: p.lastKnownWalletRub,
          lastRegularObservedRub: p.lastRegularObservedRub,
          lastWalletObservedRub: p.lastWalletObservedRub,
        },
      });

      const sellerSnapshot = buildSellerSnapshotFromProduct(p);
      const destFilter =
        selectedRegionDests.length > 0
          ? selectedRegionDests
          : opts.regionDest
            ? [opts.regionDest]
            : [];
      const recentRegionalSnapshots =
        destFilter.length > 0
          ? await prisma.priceSnapshot.findMany({
              where: { productId: p.id, regionDest: { in: destFilter } },
              orderBy: [{ parsedAt: "desc" }, { id: "desc" }],
            })
          : [];
      const regionalByDest = new Map<string, (typeof recentRegionalSnapshots)[number]>();
      for (const s of recentRegionalSnapshots) {
        const k = (s.regionDest ?? "").trim();
        if (!k) continue;
        if (!regionalByDest.has(k)) regionalByDest.set(k, s);
      }
      const trustedRegional = [...regionalByDest.values()].map((s) =>
        buildBuyerRegionalSnapshotFromPriceSnapshot(s),
      );
      const currentRegional = buildBuyerRegionalSnapshotFromResolved({
        nmId: p.nmId,
        dest: opts.regionDest ?? null,
        resolved,
        parseError: dom.error ?? null,
        inStock: dom.inStock ?? null,
        timestampIso: new Date().toISOString(),
      });
      if (currentRegional.dest) {
        const idx = trustedRegional.findIndex((r) => (r.dest ?? "") === currentRegional.dest);
        if (idx >= 0) trustedRegional[idx] = currentRegional;
        else trustedRegional.push(currentRegional);
      } else {
        trustedRegional.push(currentRegional);
      }
      const trustedBase = aggregateTrustedProductSnapshot({
        nmId: p.nmId,
        seller: sellerSnapshot,
        regional: trustedRegional,
        totalRegionsCount: Math.max(destFilter.length, trustedRegional.length, 1),
        minVerifiedRegions: Math.max(1, env.REPRICER_MIN_VALID_REGIONS_FOR_ENFORCE),
      });
      const trusted = evaluateTrustedRepricingDecision({
        trusted: trustedBase,
        minPriceRub: minAllowed,
      });
      const observedWallet = trusted.aggregatedShowcaseWithWalletRub;
      const observedRegular = trusted.aggregatedPriceWithSppRub;
      const walletConf =
        trusted.confidenceLevel === "HIGH"
          ? 1
          : trusted.confidenceLevel === "MEDIUM"
            ? 0.7
            : 0.3;
      const hardSafetyBlockers = [...resolved.blockedBySafetyRule, ...trusted.blockedBySafetyRule];

      if (!trusted.repricingAllowed) {
        await writeAuditLog({
          action: "protection.skip",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            nmId: p.nmId,
            reason: "guard_trusted_snapshot_not_ready",
            verificationStatus: resolved.buyerPriceVerification.verificationStatus,
            verificationReason: resolved.buyerPriceVerification.verificationReason,
            priceParseMode: resolved.priceParseMode,
            usedFallback: resolved.fallback.usedFallback,
            repricingAllowedReason: resolved.repricingAllowedReason,
            blockedBySafetyRule: resolved.blockedBySafetyRule,
            confidence: resolved.confidence,
            trustedFrontStatus: trusted.frontStatus,
            trustedValidRegions: trusted.validRegionsCount,
            trustedTotalRegions: trusted.totalRegionsCount,
            trustedReason: trusted.repricingAllowedReason,
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
            meta: { nmId: p.nmId, reason: "nm_not_found" },
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
        walletParseConfidence: walletConf,
        minWalletConfidence: env.REPRICER_MIN_WALLET_PARSE_CONFIDENCE,
      });

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
        const snaps = await prisma.priceSnapshot.findMany({
          where: { productId: p.id, regionDest: { in: destFilter } },
          orderBy: [{ parsedAt: "desc" }, { id: "desc" }],
        });
        const perDest = new Map<string, typeof snaps[number]>();
        for (const s of snaps) {
          const key = (s.regionDest ?? "").trim();
          if (!key) continue;
          if (!perDest.has(key)) perDest.set(key, s);
        }
        const totalRegionsCount = destFilter.length;
        let validRegionsCount = 0;
        for (const d of destFilter) {
          const snap = perDest.get(d.trim());
          if (!snap) continue;
          const dj = parseSnapshotDetailJson(snap.detailJson);
          if (dj.repricingAllowed === true && dj.confidence === "HIGH") {
            validRegionsCount += 1;
          }
        }
        if (validRegionsCount < Math.min(env.REPRICER_MIN_VALID_REGIONS_FOR_ENFORCE, totalRegionsCount)) {
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
          const max = Math.max(...vals);
          const min = Math.min(...vals);
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          const spreadPct = avg > 0 ? ((max - min) / avg) * 100 : 0;
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

      if (eng.action === "no_change" || eng.action === "skip") {
        const skipNoWallet =
          eng.reasonCode === "skipped_no_wallet" ||
          eng.reasonCode === "skipped_low_confidence" ||
          eng.reasonCode === "skipped_no_observed_final";
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
              parseConfidence: walletConf,
              syncJobId: job.id,
            },
          });
        }
        await writeAuditLog({
          action: `protection.${eng.action}`,
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: opts.dryRun,
          meta: {
            nmId: p.nmId,
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
            nmId: p.nmId,
            reason: "guard_safety_blockers",
            blockedBySafetyRule: hardSafetyBlockers,
            confidence: resolved.confidence,
            verificationReason: resolved.buyerPriceVerification.verificationReason,
          },
        });
        skipped += 1;
        processed += 1;
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        continue;
      }

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
            parseConfidence: walletConf,
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
            nmId: p.nmId,
            expectedFinal: eng.expectedFinalPrice,
            observedFinal: eng.observedFinalPrice,
            reason: eng.reason,
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
            parseConfidence: walletConf,
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
            nmId: p.nmId,
            expectedFinal: eng.expectedFinalPrice,
            observedFinal: eng.observedFinalPrice,
            reason: eng.reason,
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
            parseConfidence: walletConf,
            syncJobId: job.id,
          },
        });
        await writeAuditLog({
          action: "protection.price_raise_failed",
          entityType: "WbProduct",
          entityId: p.id,
          dryRun: false,
          meta: { nmId: p.nmId, error: msg.slice(0, 500), proposed },
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
  } finally {
    if (ephemeralProfileDir) {
      removeEphemeralWalletProfileDir(ephemeralProfileDir);
    }
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
