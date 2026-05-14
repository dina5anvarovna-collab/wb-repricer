/**
 * Backfill PriceSnapshot rows из последних FloorProtectionLog.allRegionsJson —
 * чтобы CatalogPage показывал свежие цены покупателя без нового парсинга.
 */

import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

const TAG = "floor_backfill_snapshots";

type RegionObs = {
  dest: string;
  label: string;
  clientPriceRub: number | null;
  basicPriceRub: number | null;
  ok: boolean;
};

export async function backfillPriceSnapshotsFromFloorLog(): Promise<{
  productsTouched: number;
  snapshotsWritten: number;
}> {
  // Берём все активные товары
  const products = await prisma.wbProduct.findMany({
    where: { isActive: true },
    select: {
      id: true,
      nmId: true,
      sellerPrice: true,
      sellerDiscount: true,
      discountedPriceRub: true,
    },
  });
  if (products.length === 0) return { productsTouched: 0, snapshotsWritten: 0 };

  const nmIds = products.map((p) => p.nmId).filter((x): x is number => x != null);

  // Последний FloorProtectionLog с allRegionsJson на nmId
  const logs = await prisma.floorProtectionLog.findMany({
    where: { nmId: { in: nmIds }, allRegionsJson: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { nmId: true, allRegionsJson: true, createdAt: true },
  });
  const latestPerNm = new Map<number, { allRegionsJson: string | null; createdAt: Date }>();
  for (const l of logs) {
    if (!latestPerNm.has(l.nmId)) latestPerNm.set(l.nmId, l);
  }

  // Один SyncJob на этот backfill
  const job = await prisma.syncJob.create({
    data: { type: "monitor", status: "running", meta: JSON.stringify({ source: "floor_backfill" }) },
  });

  let productsTouched = 0;
  let snapshotsWritten = 0;

  for (const p of products) {
    if (p.nmId == null) continue;
    const log = latestPerNm.get(p.nmId);
    if (!log?.allRegionsJson) continue;
    let regions: RegionObs[] = [];
    try {
      regions = JSON.parse(log.allRegionsJson);
    } catch {
      continue;
    }
    if (!Array.isArray(regions) || regions.length === 0) continue;
    productsTouched++;
    // sellerEffective = базовая × (1 - скидка продавца%). НЕ discountedPriceRub —
    // в нём уже сидит СПП. Нам нужна точка ПОСЛЕ скидки продавца, ДО СПП.
    const sellerEff = p.sellerPrice != null && p.sellerPrice > 0
      ? p.sellerPrice * (1 - (p.sellerDiscount ?? 0) / 100)
      : null;
    for (const r of regions) {
      if (!r.ok || r.clientPriceRub == null) continue;
      const sppPercent = sellerEff != null && sellerEff > 0 && r.clientPriceRub < sellerEff
        ? Math.round(((sellerEff - r.clientPriceRub) / sellerEff) * 1000) / 10
        : null;
      const sppRub = sellerEff != null ? Math.max(0, Math.round(sellerEff - r.clientPriceRub)) : null;
      await prisma.priceSnapshot.create({
        data: {
          productId: p.id,
          nmId: p.nmId,
          sellerPrice: p.sellerPrice ?? null,
          sellerDiscountPctSnapshot: p.sellerDiscount ?? null,
          sellerDiscountedSnapshotRub: p.discountedPriceRub ?? null,
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
          parsedAt: log.createdAt,
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
      snapshotsWritten++;
    }
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: "done",
      finishedAt: new Date(),
      meta: JSON.stringify({ source: "floor_backfill", productsTouched, snapshotsWritten }),
    },
  });

  logger.info({ tag: TAG, productsTouched, snapshotsWritten }, "backfill done");
  return { productsTouched, snapshotsWritten };
}
