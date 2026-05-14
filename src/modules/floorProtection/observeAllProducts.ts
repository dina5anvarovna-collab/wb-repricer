/**
 * Observer всех активных товаров: опрашивает card.wb.ru по регионам и пишет
 * PriceSnapshot, чтобы каталог показывал свежие цены покупателя по регионам
 * для всех товаров (не только под защитой пола).
 */

import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { observeMultiRegion } from "./observeMultiRegion.js";
import { getDestClusters } from "./regions.js";

const TAG = "observe_all";

export async function runObserveAllProducts(opts?: {
  destListOverride?: string;
  concurrency?: number;
}): Promise<{ processed: number; snapshotsWritten: number; failed: number }> {
  const destListOverride = opts?.destListOverride;
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 3, 10));

  const products = await prisma.wbProduct.findMany({
    where: { isActive: true },
    select: { id: true, nmId: true, sellerPrice: true, sellerDiscount: true, discountedPriceRub: true },
  });

  if (products.length === 0) {
    return { processed: 0, snapshotsWritten: 0, failed: 0 };
  }

  const job = await prisma.syncJob.create({
    data: { type: "observe_all", status: "running" },
  });

  let snapshotsWritten = 0;
  let failed = 0;
  let processed = 0;

  // simple concurrency pool
  const queue = [...products];
  async function worker() {
    while (queue.length > 0) {
      const p = queue.shift();
      if (!p || p.nmId == null) continue;
      try {
        const obs = await observeMultiRegion(p.nmId, destListOverride);
        processed++;
        for (const r of obs.allRegions) {
          if (!r.ok || r.clientPriceRub == null) continue;
          const wallet = r.clientPriceRub;
          const regular = r.basicPriceRub ?? null;
          await prisma.priceSnapshot.create({
            data: {
              productId: p.id,
              nmId: p.nmId,
              sellerPrice: p.sellerPrice ?? null,
              sellerDiscountPctSnapshot: p.sellerDiscount ?? null,
              sellerDiscountedSnapshotRub: p.discountedPriceRub ?? null,
              walletRub: wallet,
              walletConfirmed: true,
              walletSource: "card_wb_public",
              showcaseRub: wallet,
              buyerWalletPrice: wallet,
              nonWalletRub: regular,
              buyerRegularPrice: regular,
              regionDest: r.dest,
              regionLabel: r.label,
              syncJobId: job.id,
              status: "ok",
              parseConfidence: 0.95,
              parseMethod: "card_wb_public",
              walletParseStatus: "ok",
              evaluationStatus: "ok",
            },
          });
          snapshotsWritten++;
        }
      } catch (e) {
        failed++;
        logger.warn({ tag: TAG, nmId: p.nmId, err: (e as Error).message }, "observe failed");
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: failed === processed && processed > 0 ? "failed" : "done",
      finishedAt: new Date(),
      meta: JSON.stringify({ processed, snapshotsWritten, failed }),
    },
  });

  logger.info({ tag: TAG, processed, snapshotsWritten, failed }, "observe-all done");
  // touch clusters for tag clarity
  void getDestClusters;

  return { processed, snapshotsWritten, failed };
}
