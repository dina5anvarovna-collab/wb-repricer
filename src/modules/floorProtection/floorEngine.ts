/**
 * Floor Protection Engine — главный цикл.
 *
 * Инвариант: min(clientPriceRub across monitored regions) >= floorPriceRub
 *
 * Алгоритм для каждого SKU:
 *   1. OBSERVE   — запросить card.wb.ru по всем регионам параллельно
 *   2. EVALUATE  — сравнить minBuyerPriceRub с floorPriceRub
 *   3. UPLOAD    — если нарушение, поднять basePrice (если не dryRun)
 *   4. LOG       — записать в FloorProtectionLog
 *   5. NOTIFY    — Telegram alert
 *   6. POST-VERIFY (через postVerifyDelayMs) — подтвердить восстановление
 */

import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { fetchGoodsPriceByNmId, uploadGoodsPricesTask } from "../wbSellerApi/client.js";
import { observeMultiRegion } from "./observeMultiRegion.js";
import { computeRaise } from "./computeRaise.js";
import { sendTelegramAlert } from "./telegramAlert.js";
import type { FloorEngineRunResult, MultiRegionObservation, SkuFloorConfig } from "./types.js";

const TAG = "floor_engine";
const MAX_POST_VERIFY_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getActiveFloorConfigs(): Promise<SkuFloorConfig[]> {
  const rules = await prisma.minPriceRule.findMany({
    where: { controlEnabled: true },
    include: { product: { select: { id: true, nmId: true } } },
  });

  return rules
    .filter((r) => r.product?.nmId != null && r.minAllowedFinalPrice > 0)
    .map((r) => ({
      productId: r.product.id,
      nmId: r.product.nmId!,
      floorPriceRub: r.minAllowedFinalPrice,
      enabled: r.controlEnabled,
      maxStepPercent: r.maxIncreasePercentPerCycle,
      cooldownMinutes: r.cooldownMinutes,
      lastSuccessfulRaiseAt: r.lastSuccessfulRaiseAt,
    }));
}

async function isInCooldown(cfg: SkuFloorConfig): Promise<boolean> {
  if (!cfg.lastSuccessfulRaiseAt) return false;
  const elapsed = Date.now() - cfg.lastSuccessfulRaiseAt.getTime();
  return elapsed < cfg.cooldownMinutes * 60_000;
}

async function writeLog(params: {
  nmId: number;
  productId: string;
  action: string;
  floorPriceRub: number;
  minBuyerPriceRub: number | null;
  worstCaseDest: string | null;
  worstCaseLabel: string | null;
  kObserved: number | null;
  kSafe: number | null;
  oldBasePrice: number | null;
  newBasePrice: number | null;
  sellerDiscount: number | null;
  reason: string;
  dryRun: boolean;
  allRegionsJson: string | null;
}): Promise<void> {
  try {
    await prisma.floorProtectionLog.create({ data: params });
  } catch (err) {
    logger.warn({ tag: TAG, err: String(err) }, "FloorProtectionLog write failed");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: один SKU
// ─────────────────────────────────────────────────────────────────────────────

export async function runFloorEngineForSku(
  cfg: SkuFloorConfig,
  token: string,
  opts: {
    dryRun: boolean;
    bufferPct: number;
    postVerifyDelayMs: number;
    destListOverride?: string;
  },
): Promise<FloorEngineRunResult> {
  const { nmId, productId, floorPriceRub } = cfg;
  const { dryRun, bufferPct, postVerifyDelayMs } = opts;

  // ── STEP 1: OBSERVE ────────────────────────────────────────────────────────
  const observation: MultiRegionObservation = await observeMultiRegion(
    nmId,
    opts.destListOverride,
  );

  if (!observation.ok || observation.minBuyerPriceRub == null) {
    await sendTelegramAlert({
      kind: "observation_failed",
      nmId,
      floorPriceRub,
      extra: observation.errorReason,
    });
    await writeLog({
      nmId, productId,
      action: "observation_failed",
      floorPriceRub,
      minBuyerPriceRub: null,
      worstCaseDest: null, worstCaseLabel: null,
      kObserved: null, kSafe: null,
      oldBasePrice: null, newBasePrice: null, sellerDiscount: null,
      reason: observation.errorReason ?? "unknown",
      dryRun,
      allRegionsJson: JSON.stringify(observation.allRegions),
    });
    return {
      nmId, productId, floorPriceRub, observation,
      decision: { action: "skip_no_data", reason: observation.errorReason ?? "observation_failed" },
      dryRun,
    };
  }

  const minBuyerPriceRub = observation.minBuyerPriceRub;

  // ── STEP 2: EVALUATE ───────────────────────────────────────────────────────
  if (minBuyerPriceRub >= floorPriceRub) {
    logger.info({ tag: TAG, nmId, minBuyerPriceRub, floorPriceRub }, "floor satisfied — skip");
    await writeLog({
      nmId, productId,
      action: "no_change",
      floorPriceRub, minBuyerPriceRub,
      worstCaseDest: observation.worstCaseDest,
      worstCaseLabel: observation.worstCaseLabel,
      kObserved: null, kSafe: null,
      oldBasePrice: null, newBasePrice: null, sellerDiscount: null,
      reason: "floor_satisfied",
      dryRun,
      allRegionsJson: null,
    });
    return {
      nmId, productId, floorPriceRub, observation,
      decision: { action: "no_change", reason: "floor_satisfied" },
      dryRun,
    };
  }

  // Нарушение обнаружено
  const gapRub = floorPriceRub - minBuyerPriceRub;
  logger.warn({
    tag: TAG, nmId, minBuyerPriceRub, floorPriceRub, gapRub,
    worstCase: observation.worstCaseLabel,
  }, "FLOOR BREACH DETECTED");

  await sendTelegramAlert({
    kind: "breach_detected",
    nmId, floorPriceRub, minBuyerPriceRub,
    worstCaseLabel: observation.worstCaseLabel ?? undefined,
    gapRub, dryRun,
  });

  // Cooldown check
  if (await isInCooldown(cfg)) {
    logger.info({ tag: TAG, nmId }, "в cooldown — пропускаем поднятие");
    return {
      nmId, productId, floorPriceRub, observation,
      decision: { action: "skip_no_data", reason: "cooldown_active" },
      dryRun,
    };
  }

  // ── STEP 3: GET SELLER DATA ────────────────────────────────────────────────
  const sellerData = await fetchGoodsPriceByNmId(token, nmId).catch(() => null);
  if (!sellerData) {
    logger.warn({ tag: TAG, nmId }, "Seller API вернул null — пропускаем");
    return {
      nmId, productId, floorPriceRub, observation,
      decision: { action: "skip_no_data", reason: "seller_api_null" },
      dryRun,
    };
  }

  const sellerEffectiveRub =
    observation.sellerEffectiveRub ??
    Math.round(sellerData.price * (1 - sellerData.discount / 100));

  // ── STEP 4: COMPUTE RAISE ──────────────────────────────────────────────────
  const decision = computeRaise({
    minBuyerPriceRub,
    sellerEffectiveRub,
    currentBasePrice: sellerData.price,
    sellerDiscountPct: sellerData.discount,
    floorPriceRub,
    bufferPct,
    maxStepPct: cfg.maxStepPercent,
  });

  logger.info({ tag: TAG, nmId, decision }, "raise decision");

  if (decision.action === "no_change" || decision.action === "skip_no_data" || decision.action === "skip_capped") {
    await writeLog({
      nmId, productId, action: decision.action, floorPriceRub, minBuyerPriceRub,
      worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
      kObserved: null, kSafe: null,
      oldBasePrice: sellerData.price, newBasePrice: null,
      sellerDiscount: sellerData.discount,
      reason: decision.reason, dryRun,
      allRegionsJson: JSON.stringify(observation.allRegions),
    });
    return { nmId, productId, floorPriceRub, observation, decision, dryRun };
  }

  // raise_full или raise_partial
  const newBase = decision.newBase;
  const kObs = "kObserved" in decision ? (decision.kObserved ?? null) : null;
  const kSf = "kSafe" in decision ? (decision.kSafe ?? null) : null;

  // ── STEP 5: UPLOAD ────────────────────────────────────────────────────────
  let uploadedAt: Date | undefined;
  if (!dryRun) {
    try {
      await uploadGoodsPricesTask(token, [
        { nmID: nmId, price: newBase, discount: sellerData.discount },
      ]);
      uploadedAt = new Date();
      logger.info({ tag: TAG, nmId, oldBase: sellerData.price, newBase }, "basePrice uploaded");

      // Обновить lastSuccessfulRaiseAt
      await prisma.minPriceRule.updateMany({
        where: { product: { nmId } },
        data: { lastSuccessfulRaiseAt: uploadedAt, lastCheckAt: uploadedAt },
      });
    } catch (err) {
      logger.error({ tag: TAG, nmId, err: String(err) }, "upload failed");
      await writeLog({
        nmId, productId, action: "upload_failed", floorPriceRub, minBuyerPriceRub,
        worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
        kObserved: kObs, kSafe: kSf,
        oldBasePrice: sellerData.price, newBasePrice: newBase,
        sellerDiscount: sellerData.discount,
        reason: `upload_error:${String(err)}`, dryRun,
        allRegionsJson: JSON.stringify(observation.allRegions),
      });
      return { nmId, productId, floorPriceRub, observation, decision, dryRun };
    }
  }

  const alertKind = decision.action === "raise_partial" ? "price_raised_partial" : "price_raised";
  await sendTelegramAlert({
    kind: alertKind,
    nmId, floorPriceRub, minBuyerPriceRub,
    oldBase: sellerData.price, newBase,
    worstCaseLabel: observation.worstCaseLabel ?? undefined,
    gapRub, dryRun,
  });

  await writeLog({
    nmId, productId,
    action: dryRun ? `${decision.action}_dry` : decision.action,
    floorPriceRub, minBuyerPriceRub,
    worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
    kObserved: kObs, kSafe: kSf,
    oldBasePrice: sellerData.price, newBasePrice: newBase,
    sellerDiscount: sellerData.discount,
    reason: decision.reason, dryRun,
    allRegionsJson: JSON.stringify(observation.allRegions),
  });

  const result: FloorEngineRunResult = {
    nmId, productId, floorPriceRub, observation, decision,
    uploadedBase: dryRun ? undefined : newBase,
    uploadedAt,
    dryRun,
  };

  // ── STEP 6: POST-VERIFY ───────────────────────────────────────────────────
  if (!dryRun) {
    void runPostVerify(result, token, opts, 1);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-verify (delayed, recursive retry)
// ─────────────────────────────────────────────────────────────────────────────

async function runPostVerify(
  original: FloorEngineRunResult,
  token: string,
  opts: { dryRun: boolean; bufferPct: number; postVerifyDelayMs: number; destListOverride?: string },
  attempt: number,
): Promise<void> {
  const { nmId, productId, floorPriceRub } = original;

  // Подождать перед проверкой (WB пересчитывает цены ~10–15 мин)
  await new Promise((r) => setTimeout(r, opts.postVerifyDelayMs));

  const verify = await observeMultiRegion(nmId, opts.destListOverride);
  const verifiedAt = new Date();
  const minBuyerPriceRub = verify.minBuyerPriceRub;

  if (minBuyerPriceRub != null && minBuyerPriceRub >= floorPriceRub) {
    logger.info({ tag: TAG, nmId, minBuyerPriceRub, floorPriceRub, attempt }, "post-verify OK");
    await sendTelegramAlert({
      kind: "verify_ok",
      nmId, floorPriceRub, minBuyerPriceRub,
      worstCaseLabel: verify.worstCaseLabel ?? undefined,
    });
    await writeLog({
      nmId, productId, action: "verify_ok", floorPriceRub, minBuyerPriceRub,
      worstCaseDest: verify.worstCaseDest, worstCaseLabel: verify.worstCaseLabel,
      kObserved: null, kSafe: null,
      oldBasePrice: original.uploadedBase ?? null, newBasePrice: null,
      sellerDiscount: null, reason: `attempt_${attempt}`, dryRun: false,
      allRegionsJson: null,
    });
    return;
  }

  const gapRub = minBuyerPriceRub != null ? floorPriceRub - minBuyerPriceRub : null;
  logger.warn({ tag: TAG, nmId, minBuyerPriceRub, floorPriceRub, attempt, gapRub },
    "post-verify FAILED — floor still breached");

  await sendTelegramAlert({
    kind: "verify_failed",
    nmId, floorPriceRub,
    minBuyerPriceRub: minBuyerPriceRub ?? undefined,
    worstCaseLabel: verify.worstCaseLabel ?? undefined,
    gapRub: gapRub ?? undefined,
    retryNum: attempt,
  });

  if (attempt >= MAX_POST_VERIFY_RETRIES) {
    logger.error({ tag: TAG, nmId, attempt }, "max retries reached — SKU frozen");
    await sendTelegramAlert({ kind: "sku_frozen", nmId, floorPriceRub });
    await prisma.minPriceRule.updateMany({
      where: { product: { nmId } },
      data: { controlEnabled: false, lastReasonCode: "frozen_max_retries" },
    });
    return;
  }

  // Повторная попытка с повышением
  const sellerData = await fetchGoodsPriceByNmId(token, nmId).catch(() => null);
  if (sellerData && minBuyerPriceRub != null) {
    const sellerEff = verify.sellerEffectiveRub
      ?? Math.round(sellerData.price * (1 - sellerData.discount / 100));
    const retry = computeRaise({
      minBuyerPriceRub,
      sellerEffectiveRub: sellerEff,
      currentBasePrice: sellerData.price,
      sellerDiscountPct: sellerData.discount,
      floorPriceRub,
      bufferPct: opts.bufferPct,
    });

    if ((retry.action === "raise_full" || retry.action === "raise_partial") && retry.newBase) {
      try {
        await uploadGoodsPricesTask(token, [
          { nmID: nmId, price: retry.newBase, discount: sellerData.discount },
        ]);
        logger.info({ tag: TAG, nmId, newBase: retry.newBase, attempt }, "retry upload OK");
        await writeLog({
          nmId, productId,
          action: `retry_${attempt}_${retry.action}`,
          floorPriceRub, minBuyerPriceRub,
          worstCaseDest: verify.worstCaseDest, worstCaseLabel: verify.worstCaseLabel,
          kObserved: "kObserved" in retry ? retry.kObserved ?? null : null,
          kSafe: "kSafe" in retry ? retry.kSafe ?? null : null,
          oldBasePrice: sellerData.price, newBasePrice: retry.newBase,
          sellerDiscount: sellerData.discount,
          reason: retry.reason, dryRun: false,
          allRegionsJson: JSON.stringify(verify.allRegions),
        });
      } catch (err) {
        logger.error({ tag: TAG, nmId, attempt, err: String(err) }, "retry upload failed");
      }
    }
  }

  // Рекурсивно — следующая попытка
  void runPostVerify(original, token, opts, attempt + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch runner: все активные SKU
// ─────────────────────────────────────────────────────────────────────────────

export async function runFloorProtectionBatch(
  token: string,
  opts: {
    dryRun?: boolean;
    bufferPct?: number;
    maxStepPct?: number;
    postVerifyDelayMs?: number;
    destListOverride?: string;
  } = {},
): Promise<{ processed: number; raised: number; skipped: number }> {
  const {
    dryRun = false,
    bufferPct = 0.05,
    postVerifyDelayMs = 15 * 60_000, // 15 мин по умолчанию
    destListOverride,
  } = opts;

  const configs = await getActiveFloorConfigs();
  logger.info({ tag: TAG, count: configs.length, dryRun }, "floor protection batch started");

  let raised = 0;
  let skipped = 0;

  for (const cfg of configs) {
    try {
      const result = await runFloorEngineForSku(cfg, token, {
        dryRun,
        bufferPct,
        postVerifyDelayMs,
        destListOverride,
      });

      const action = result.decision.action;
      if (action === "raise_full" || action === "raise_partial") {
        raised++;
      } else {
        skipped++;
      }

      // Небольшая пауза между SKU, чтобы не перегружать card.wb.ru
      await new Promise((r) => setTimeout(r, 1_000));
    } catch (err) {
      logger.error({ tag: TAG, nmId: cfg.nmId, err: String(err) }, "SKU processing error");
      skipped++;
    }
  }

  logger.info({ tag: TAG, processed: configs.length, raised, skipped }, "floor protection batch done");
  return { processed: configs.length, raised, skipped };
}
