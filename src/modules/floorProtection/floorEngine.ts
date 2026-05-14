/**
 * Floor Protection Engine
 *
 * Инвариант: buyer_wallet_price >= floorPriceRub
 *   floorPriceRub = minAllowedFinalPrice = минимальная цена которую видит покупатель С кошельком.
 *
 * Алгоритм:
 *   1. OBSERVE   — card.wb.ru (buyer wallet price по регионам)
 *   2. EVALUATE  — buyer_wallet_price >= floorPriceRub → skip
 *   3. READ DB   — sellerPrice / sellerDiscount из WbProduct
 *   4. COMPUTE   — рассчитать newBase через kObserved
 *   5. UPLOAD    — Seller API (batch: все SKU в одном запросе)
 *   6. POST-VERIFY — повторная проверка через postVerifyDelayMs
 *      Заморозка ТОЛЬКО если наблюдение прошло успешно и цена всё ещё ниже floor.
 *      Если card.wb.ru недоступен (403/no data) — не замораживаем, ждём следующего цикла.
 */

import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { uploadGoodsPricesTask } from "../wbSellerApi/client.js";
import { observeMultiRegion } from "./observeMultiRegion.js";
import { computeRaise } from "./computeRaise.js";
import { sendTelegramAlert } from "./telegramAlert.js";
import type { FloorEngineRunResult, MultiRegionObservation, RaiseDecision, SkuFloorConfig } from "./types.js";

const TAG = "floor_engine";
const MAX_POST_VERIFY_RETRIES = 5;

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
      safetyBufferPercent: r.safetyBufferPercent,
    }));
}

async function isInCooldown(cfg: SkuFloorConfig): Promise<boolean> {
  if (!cfg.lastSuccessfulRaiseAt) return false;
  return Date.now() - cfg.lastSuccessfulRaiseAt.getTime() < cfg.cooldownMinutes * 60_000;
}

async function readSellerDataFromDb(
  nmId: number,
): Promise<{ currentBasePrice: number; sellerDiscountPct: number } | null> {
  const product = await prisma.wbProduct.findFirst({
    where: { nmId },
    select: { sellerPrice: true, sellerDiscount: true },
  });
  if (!product?.sellerPrice || product.sellerPrice <= 0) {
    logger.warn({ tag: TAG, nmId }, "WbProduct not found or sellerPrice=0");
    return null;
  }
  return {
    currentBasePrice: Math.round(product.sellerPrice),
    sellerDiscountPct: product.sellerDiscount ?? 0,
  };
}

async function writeLog(params: {
  nmId: number; productId: string; action: string; floorPriceRub: number;
  minBuyerPriceRub: number | null; worstCaseDest: string | null; worstCaseLabel: string | null;
  kObserved: number | null; kSafe: number | null; oldBasePrice: number | null;
  newBasePrice: number | null; sellerDiscount: number | null; reason: string;
  dryRun: boolean; allRegionsJson: string | null;
}): Promise<void> {
  try {
    await prisma.floorProtectionLog.create({ data: params });
  } catch (err) {
    logger.warn({ tag: TAG, err: String(err) }, "FloorProtectionLog write failed");
  }
  // Also write PriceSnapshot rows so CatalogPage shows fresh per-region prices.
  if (params.allRegionsJson) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const regions = JSON.parse(params.allRegionsJson) as Array<any>;
      const validRegions = regions.filter((r) => r?.ok && r?.clientPriceRub != null);
      if (validRegions.length > 0) {
        const prod = await prisma.wbProduct.findFirst({
          where: { nmId: params.nmId },
          select: { id: true, sellerPrice: true, sellerDiscount: true, discountedPriceRub: true },
        });
        if (prod) {
          const job = await prisma.syncJob.create({
            data: { type: "monitor", status: "done", finishedAt: new Date(),
              meta: JSON.stringify({ source: "floor_engine", nmId: params.nmId }) },
          });
          const sellerEff = prod.sellerPrice != null && prod.sellerPrice > 0
            ? prod.sellerPrice * (1 - (prod.sellerDiscount ?? 0) / 100)
            : null;
          for (const r of validRegions) {
            const sppPercent = sellerEff != null && sellerEff > 0 && r.clientPriceRub < sellerEff
              ? Math.round(((sellerEff - r.clientPriceRub) / sellerEff) * 1000) / 10
              : null;
            const sppRub = sellerEff != null ? Math.max(0, Math.round(sellerEff - r.clientPriceRub)) : null;
            await prisma.priceSnapshot.create({
              data: {
                productId: prod.id,
                nmId: params.nmId,
                sellerPrice: prod.sellerPrice ?? null,
                sellerDiscountPctSnapshot: prod.sellerDiscount ?? null,
                sellerDiscountedSnapshotRub: prod.discountedPriceRub ?? null,
                walletRub: r.clientPriceRub,
                walletConfirmed: true,
                walletSource: "card_wb_public",
                showcaseRub: r.clientPriceRub,
                buyerWalletPrice: r.clientPriceRub,
                nonWalletRub: r.basicPriceRub ?? null,
                buyerRegularPrice: r.basicPriceRub ?? null,
                regionDest: r.dest,
                regionLabel: r.label,
                syncJobId: job.id,
                status: "ok",
                parseConfidence: 0.95,
                parseMethod: "card_wb_public",
                walletParseStatus: "ok",
                evaluationStatus: "ok",
                detailJson: JSON.stringify({
                  parseStatus: "ok",
                  verificationSource: "card_api",
                  confidence: "HIGH",
                  sourceConfidence: "high",
                  regionalVerificationStatus: "VERIFIED",
                  repricingAllowed: true,
                  sppPercent,
                  sppRub,
                  sellerDiscountPriceRub: sellerEff != null ? Math.round(sellerEff) : null,
                  buyerPriceVerification: {
                    verificationStatus: "VERIFIED",
                    verificationReason: "card_wb_public_per_region",
                    repricingAllowed: true,
                  },
                }),
              },
            });
          }
        }
      }
    } catch (err) {
      logger.warn({ tag: TAG, err: String(err) }, "PriceSnapshot write from floor engine failed");
    }
  }
}

// Retry upload once on 429 after a brief pause (30 s).
// A second 429 is surfaced immediately — caller decides whether to log and skip.
async function uploadWithRetry(
  token: string,
  rows: Array<{ nmID: number; price: number; discount: number }>,
  retryDelayMs = 31_000,
): Promise<void> {
  try {
    await uploadGoodsPricesTask(token, rows);
  } catch (err) {
    if (String(err).includes("429")) {
      logger.warn({ tag: TAG, retryDelayMs }, "upload 429 — waiting before retry");
      await new Promise((r) => setTimeout(r, retryDelayMs));
      await uploadGoodsPricesTask(token, rows); // throws if still 429
    } else {
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: steps 1-4 — observe + compute raise decision. No upload side effect.
// ─────────────────────────────────────────────────────────────────────────────

type PendingRaise = {
  cfg: SkuFloorConfig;
  observation: MultiRegionObservation;
  decision: RaiseDecision & { action: "raise_full" | "raise_partial"; newBase: number };
  minBuyerPriceRub: number;
  currentBasePrice: number;
  sellerDiscountPct: number;
  gapRub: number;
  kObs: number | null;
  bufferPct: number;
};

type SkuEvalResult =
  | { kind: "terminal"; result: FloorEngineRunResult }
  | { kind: "pending_raise"; pending: PendingRaise };

async function evaluateSkuForFloor(
  cfg: SkuFloorConfig,
  opts: { dryRun: boolean; bufferPct: number; postVerifyDelayMs: number; destListOverride?: string },
): Promise<SkuEvalResult> {
  const { nmId, productId, floorPriceRub } = cfg;
  const { dryRun } = opts;
  const bufferPct = cfg.safetyBufferPercent > 0 ? cfg.safetyBufferPercent / 100 : opts.bufferPct;

  const observation: MultiRegionObservation = await observeMultiRegion(nmId, opts.destListOverride);

  if (!observation.ok || observation.minBuyerPriceRub == null) {
    logger.warn({ tag: TAG, nmId, reason: observation.errorReason }, "observation failed — skip");
    await writeLog({
      nmId, productId, action: "observation_failed", floorPriceRub,
      minBuyerPriceRub: null, worstCaseDest: null, worstCaseLabel: null,
      kObserved: null, kSafe: null, oldBasePrice: null, newBasePrice: null, sellerDiscount: null,
      reason: observation.errorReason ?? "unknown", dryRun,
      allRegionsJson: JSON.stringify(observation.allRegions),
    });
    return {
      kind: "terminal",
      result: {
        nmId, productId, floorPriceRub, observation,
        decision: { action: "skip_no_data", reason: observation.errorReason ?? "observation_failed" },
        dryRun,
      },
    };
  }

  const minBuyerPriceRub = observation.minBuyerPriceRub;

  if (minBuyerPriceRub >= floorPriceRub) {
    logger.info({ tag: TAG, nmId, minBuyerPriceRub, floorPriceRub }, "floor satisfied — skip");
    await writeLog({
      nmId, productId, action: "no_change", floorPriceRub, minBuyerPriceRub,
      worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
      kObserved: null, kSafe: null, oldBasePrice: null, newBasePrice: null, sellerDiscount: null,
      reason: "floor_satisfied", dryRun, allRegionsJson: null,
    });
    return {
      kind: "terminal",
      result: {
        nmId, productId, floorPriceRub, observation,
        decision: { action: "no_change", reason: "floor_satisfied" }, dryRun,
      },
    };
  }

  const gapRub = floorPriceRub - minBuyerPriceRub;
  logger.warn({
    tag: TAG, nmId, minBuyerPriceRub, floorPriceRub, gapRub, worstCase: observation.worstCaseLabel,
  }, "FLOOR BREACH DETECTED");

  await sendTelegramAlert({
    kind: "breach_detected", nmId, floorPriceRub, minBuyerPriceRub,
    worstCaseLabel: observation.worstCaseLabel ?? undefined, gapRub, dryRun,
  });

  if (await isInCooldown(cfg)) {
    logger.info({ tag: TAG, nmId }, "в cooldown — пропускаем");
    return {
      kind: "terminal",
      result: {
        nmId, productId, floorPriceRub, observation,
        decision: { action: "skip_no_data", reason: "cooldown_active" }, dryRun,
      },
    };
  }

  const dbData = await readSellerDataFromDb(nmId);
  if (!dbData) {
    await writeLog({
      nmId, productId, action: "skip_no_db_data", floorPriceRub, minBuyerPriceRub,
      worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
      kObserved: null, kSafe: null, oldBasePrice: null, newBasePrice: null, sellerDiscount: null,
      reason: "no_product_in_db_run_sync", dryRun,
      allRegionsJson: JSON.stringify(observation.allRegions),
    });
    return {
      kind: "terminal",
      result: {
        nmId, productId, floorPriceRub, observation,
        decision: { action: "skip_no_data", reason: "no_product_in_db_run_sync" }, dryRun,
      },
    };
  }

  const { currentBasePrice, sellerDiscountPct } = dbData;
  const sellerEffectiveRub =
    observation.sellerEffectiveRub ??
    Math.round(currentBasePrice * (1 - sellerDiscountPct / 100));

  logger.info({ tag: TAG, nmId, currentBasePrice, sellerDiscountPct, sellerEffectiveRub }, "seller data from DB");

  const decision = computeRaise({
    minBuyerPriceRub, sellerEffectiveRub, currentBasePrice, sellerDiscountPct,
    floorPriceRub, bufferPct, maxStepPct: cfg.maxStepPercent,
  });
  logger.info({ tag: TAG, nmId, decision }, "raise decision");

  if (decision.action === "no_change" || decision.action === "skip_no_data" || decision.action === "skip_capped") {
    await writeLog({
      nmId, productId, action: decision.action, floorPriceRub, minBuyerPriceRub,
      worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
      kObserved: "kObserved" in decision ? (decision.kObserved ?? null) : null,
      kSafe: null, oldBasePrice: currentBasePrice, newBasePrice: null,
      sellerDiscount: sellerDiscountPct, reason: decision.reason, dryRun,
      allRegionsJson: JSON.stringify(observation.allRegions),
    });
    return {
      kind: "terminal",
      result: { nmId, productId, floorPriceRub, observation, decision, dryRun },
    };
  }

  if (decision.action !== "raise_full" && decision.action !== "raise_partial") {
    return {
      kind: "terminal",
      result: { nmId, productId, floorPriceRub, observation, decision, dryRun },
    };
  }

  const kObs = "kObserved" in decision ? (decision.kObserved ?? null) : null;
  return {
    kind: "pending_raise",
    pending: {
      cfg, observation, decision: decision as PendingRaise["decision"],
      minBuyerPriceRub, currentBasePrice, sellerDiscountPct, gapRub, kObs, bufferPct,
    },
  };
}

// Finalize a successful upload for one SKU: update DB, send Telegram, write log, schedule post-verify.
async function finalizeUploadedRaise(
  pending: PendingRaise,
  uploadedAt: Date,
  token: string,
  opts: { dryRun: boolean; bufferPct: number; postVerifyDelayMs: number; destListOverride?: string },
): Promise<FloorEngineRunResult> {
  const { cfg, observation, decision, minBuyerPriceRub, currentBasePrice, sellerDiscountPct, gapRub, kObs } = pending;
  const { nmId, productId, floorPriceRub } = cfg;
  const newBase = decision.newBase;
  const dryRun = opts.dryRun;

  await prisma.minPriceRule.updateMany({
    where: { product: { nmId } },
    data: { lastSuccessfulRaiseAt: uploadedAt, lastCheckAt: uploadedAt },
  });
  await prisma.wbProduct.updateMany({ where: { nmId }, data: { sellerPrice: newBase } });

  logger.info({ tag: TAG, nmId, oldBase: currentBasePrice, newBase }, "basePrice uploaded");

  await sendTelegramAlert({
    kind: decision.action === "raise_partial" ? "price_raised_partial" : "price_raised",
    nmId, floorPriceRub, minBuyerPriceRub, oldBase: currentBasePrice, newBase,
    worstCaseLabel: observation.worstCaseLabel ?? undefined, gapRub, dryRun,
  });
  await writeLog({
    nmId, productId, action: dryRun ? `${decision.action}_dry` : decision.action,
    floorPriceRub, minBuyerPriceRub,
    worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
    kObserved: kObs, kSafe: null, oldBasePrice: currentBasePrice, newBasePrice: newBase,
    sellerDiscount: sellerDiscountPct, reason: decision.reason, dryRun,
    allRegionsJson: JSON.stringify(observation.allRegions),
  });

  const result: FloorEngineRunResult = {
    nmId, productId, floorPriceRub, observation, decision,
    uploadedBase: newBase, uploadedAt, dryRun,
  };

  if (!dryRun) void runPostVerify(result, token, opts, 1);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: run floor protection for a single SKU (upload included).
// Kept for backward compatibility / direct API calls.
// ─────────────────────────────────────────────────────────────────────────────

export async function runFloorEngineForSku(
  cfg: SkuFloorConfig,
  token: string,
  opts: { dryRun: boolean; bufferPct: number; postVerifyDelayMs: number; destListOverride?: string },
): Promise<FloorEngineRunResult> {
  const evalResult = await evaluateSkuForFloor(cfg, opts);
  if (evalResult.kind === "terminal") return evalResult.result;

  const { pending } = evalResult;
  const { cfg: c, decision, sellerDiscountPct } = pending;
  const { nmId, productId, floorPriceRub } = c;
  const newBase = decision.newBase;
  const { dryRun } = opts;

  if (dryRun) {
    await sendTelegramAlert({
      kind: decision.action === "raise_partial" ? "price_raised_partial" : "price_raised",
      nmId, floorPriceRub, minBuyerPriceRub: pending.minBuyerPriceRub,
      oldBase: pending.currentBasePrice, newBase,
      worstCaseLabel: pending.observation.worstCaseLabel ?? undefined,
      gapRub: pending.gapRub, dryRun,
    });
    await writeLog({
      nmId, productId, action: `${decision.action}_dry`, floorPriceRub,
      minBuyerPriceRub: pending.minBuyerPriceRub,
      worstCaseDest: pending.observation.worstCaseDest,
      worstCaseLabel: pending.observation.worstCaseLabel,
      kObserved: pending.kObs, kSafe: null, oldBasePrice: pending.currentBasePrice,
      newBasePrice: newBase, sellerDiscount: sellerDiscountPct, reason: decision.reason, dryRun,
      allRegionsJson: JSON.stringify(pending.observation.allRegions),
    });
    return {
      nmId, productId, floorPriceRub, observation: pending.observation, decision,
      uploadedBase: undefined, uploadedAt: undefined, dryRun,
    };
  }

  try {
    await uploadWithRetry(token, [{ nmID: nmId, price: newBase, discount: sellerDiscountPct }]);
  } catch (err) {
    logger.error({ tag: TAG, nmId, err: String(err) }, "upload failed");
    await writeLog({
      nmId, productId, action: "upload_failed", floorPriceRub,
      minBuyerPriceRub: pending.minBuyerPriceRub,
      worstCaseDest: pending.observation.worstCaseDest,
      worstCaseLabel: pending.observation.worstCaseLabel,
      kObserved: pending.kObs, kSafe: null, oldBasePrice: pending.currentBasePrice,
      newBasePrice: newBase, sellerDiscount: sellerDiscountPct,
      reason: `upload_error:${String(err)}`, dryRun,
      allRegionsJson: JSON.stringify(pending.observation.allRegions),
    });
    return { nmId, productId, floorPriceRub, observation: pending.observation, decision, dryRun };
  }

  return finalizeUploadedRaise(pending, new Date(), token, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-verify: проверяем buyer wallet price.
// НЕ замораживаем если card.wb.ru недоступен (403) — ждём следующего цикла.
// ─────────────────────────────────────────────────────────────────────────────

async function runPostVerify(
  original: FloorEngineRunResult,
  token: string,
  opts: { dryRun: boolean; bufferPct: number; postVerifyDelayMs: number; destListOverride?: string },
  attempt: number,
): Promise<void> {
  const { nmId, productId, floorPriceRub } = original;
  await new Promise((r) => setTimeout(r, opts.postVerifyDelayMs));

  const verify = await observeMultiRegion(nmId, opts.destListOverride);
  const minBuyerPriceRub = verify.minBuyerPriceRub;

  if (!verify.ok || minBuyerPriceRub == null) {
    logger.warn({ tag: TAG, nmId, attempt }, "post-verify: observation failed — skipping (no freeze)");
    return;
  }

  if (minBuyerPriceRub >= floorPriceRub) {
    logger.info({ tag: TAG, nmId, minBuyerPriceRub, floorPriceRub, attempt }, "post-verify OK");
    await sendTelegramAlert({
      kind: "verify_ok", nmId, floorPriceRub, minBuyerPriceRub,
      worstCaseLabel: verify.worstCaseLabel ?? undefined,
    });
    await writeLog({
      nmId, productId, action: "verify_ok", floorPriceRub, minBuyerPriceRub,
      worstCaseDest: verify.worstCaseDest, worstCaseLabel: verify.worstCaseLabel,
      kObserved: null, kSafe: null, oldBasePrice: original.uploadedBase ?? null, newBasePrice: null,
      sellerDiscount: null, reason: `attempt_${attempt}`, dryRun: false, allRegionsJson: null,
    });
    return;
  }

  const gapRub = floorPriceRub - minBuyerPriceRub;
  logger.warn({ tag: TAG, nmId, minBuyerPriceRub, floorPriceRub, attempt, gapRub },
    "post-verify FAILED — floor still breached");

  await sendTelegramAlert({
    kind: "verify_failed", nmId, floorPriceRub, minBuyerPriceRub,
    worstCaseLabel: verify.worstCaseLabel ?? undefined, gapRub, retryNum: attempt,
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

  const dbData = await readSellerDataFromDb(nmId);
  if (dbData) {
    const { currentBasePrice, sellerDiscountPct } = dbData;
    const sellerEffectiveRub =
      verify.sellerEffectiveRub ?? Math.round(currentBasePrice * (1 - sellerDiscountPct / 100));
    const retry = computeRaise({
      minBuyerPriceRub, sellerEffectiveRub, currentBasePrice, sellerDiscountPct,
      floorPriceRub, bufferPct: opts.bufferPct,
    });
    if ((retry.action === "raise_full" || retry.action === "raise_partial") && retry.newBase) {
      try {
        await uploadWithRetry(token, [{ nmID: nmId, price: retry.newBase, discount: sellerDiscountPct }]);
        logger.info({ tag: TAG, nmId, newBase: retry.newBase, attempt }, "retry upload OK");
        await prisma.wbProduct.updateMany({ where: { nmId }, data: { sellerPrice: retry.newBase } });
        await writeLog({
          nmId, productId, action: `retry_${attempt}_${retry.action}`,
          floorPriceRub, minBuyerPriceRub,
          worstCaseDest: verify.worstCaseDest, worstCaseLabel: verify.worstCaseLabel,
          kObserved: "kObserved" in retry ? retry.kObserved ?? null : null,
          kSafe: null, oldBasePrice: currentBasePrice, newBasePrice: retry.newBase,
          sellerDiscount: sellerDiscountPct, reason: retry.reason, dryRun: false,
          allRegionsJson: JSON.stringify(verify.allRegions),
        });
      } catch (err) {
        logger.error({ tag: TAG, nmId, attempt, err: String(err) }, "retry upload failed");
      }
    }
  }

  void runPostVerify(original, token, opts, attempt + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch runner: один запрос к WB API для всех SKU, требующих поднятия цены.
// ─────────────────────────────────────────────────────────────────────────────

export async function runFloorProtectionBatch(
  token: string,
  opts: {
    dryRun?: boolean; bufferPct?: number; maxStepPct?: number;
    postVerifyDelayMs?: number; destListOverride?: string;
  } = {},
): Promise<{ processed: number; raised: number; skipped: number }> {
  const { dryRun = false, bufferPct = 0.025, postVerifyDelayMs = 15 * 60_000, destListOverride } = opts;
  const innerOpts = { dryRun, bufferPct, postVerifyDelayMs, destListOverride };

  const configs = await getActiveFloorConfigs();
  logger.info({ tag: TAG, count: configs.length, dryRun }, "floor protection batch started");

  // ── PHASE 1: Observe + compute decisions for all SKUs (no uploads yet) ──────
  const pendingRaises: PendingRaise[] = [];
  let skipped = 0;

  for (const cfg of configs) {
    try {
      const evalResult = await evaluateSkuForFloor(cfg, innerOpts);
      if (evalResult.kind === "terminal") {
        skipped++;
      } else {
        pendingRaises.push(evalResult.pending);
      }
    } catch (err) {
      logger.error({ tag: TAG, nmId: cfg.nmId, err: String(err) }, "SKU evaluation error");
      skipped++;
    }
  }

  if (pendingRaises.length === 0) {
    logger.info({ tag: TAG, processed: configs.length, raised: 0, skipped }, "floor protection batch done");
    return { processed: configs.length, raised: 0, skipped };
  }

  // ── PHASE 2: Batch upload all pending raises in ONE API call ─────────────────
  const rows = pendingRaises.map((p) => ({
    nmID: p.cfg.nmId,
    price: p.decision.newBase,
    discount: p.sellerDiscountPct,
  }));

  let uploadOk = false;
  const uploadedAt = new Date();

  if (!dryRun) {
    try {
      await uploadWithRetry(token, rows);
      uploadOk = true;
      logger.info({ tag: TAG, count: rows.length, nmIds: rows.map((r) => r.nmID) }, "batch upload OK");
    } catch (err) {
      logger.error({ tag: TAG, err: String(err), count: rows.length }, "batch upload failed");
      // Log upload_failed for each pending SKU
      for (const p of pendingRaises) {
        await writeLog({
          nmId: p.cfg.nmId, productId: p.cfg.productId, action: "upload_failed",
          floorPriceRub: p.cfg.floorPriceRub, minBuyerPriceRub: p.minBuyerPriceRub,
          worstCaseDest: p.observation.worstCaseDest, worstCaseLabel: p.observation.worstCaseLabel,
          kObserved: p.kObs, kSafe: null, oldBasePrice: p.currentBasePrice,
          newBasePrice: p.decision.newBase, sellerDiscount: p.sellerDiscountPct,
          reason: `upload_error:${String(err)}`, dryRun: false,
          allRegionsJson: JSON.stringify(p.observation.allRegions),
        });
        skipped++;
      }
      logger.info({
        tag: TAG, processed: configs.length, raised: 0, skipped,
      }, "floor protection batch done");
      return { processed: configs.length, raised: 0, skipped };
    }
  } else {
    uploadOk = true; // dry-run always "succeeds"
  }

  // ── PHASE 3: Finalize each raised SKU (DB update, Telegram, log, post-verify) ─
  let raised = 0;
  for (const p of pendingRaises) {
    try {
      if (dryRun) {
        const { cfg: c, decision, minBuyerPriceRub, currentBasePrice, sellerDiscountPct, gapRub, kObs, observation } = p;
        const { nmId, productId, floorPriceRub } = c;
        await sendTelegramAlert({
          kind: decision.action === "raise_partial" ? "price_raised_partial" : "price_raised",
          nmId, floorPriceRub, minBuyerPriceRub, oldBase: currentBasePrice,
          newBase: decision.newBase,
          worstCaseLabel: observation.worstCaseLabel ?? undefined, gapRub, dryRun: true,
        });
        await writeLog({
          nmId, productId, action: `${decision.action}_dry`, floorPriceRub, minBuyerPriceRub,
          worstCaseDest: observation.worstCaseDest, worstCaseLabel: observation.worstCaseLabel,
          kObserved: kObs, kSafe: null, oldBasePrice: currentBasePrice,
          newBasePrice: decision.newBase, sellerDiscount: sellerDiscountPct,
          reason: decision.reason, dryRun: true,
          allRegionsJson: JSON.stringify(observation.allRegions),
        });
      } else {
        await finalizeUploadedRaise(p, uploadedAt, token, innerOpts);
      }
      raised++;
    } catch (err) {
      logger.error({ tag: TAG, nmId: p.cfg.nmId, err: String(err) }, "finalize error");
      skipped++;
    }
  }

  logger.info({ tag: TAG, processed: configs.length, raised, skipped }, "floor protection batch done");
  return { processed: configs.length, raised, skipped };
}
