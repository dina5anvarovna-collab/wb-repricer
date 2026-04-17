import { prisma } from "../../lib/prisma.js";
import { normalizeWbProductFromDb, type NormalizedWbProduct } from "./normalizeProduct.js";

/** Сводка каталога в едином формате (из локальной БД после синхронизации Seller API). */
export async function mergeProductData(opts?: { limit?: number }): Promise<NormalizedWbProduct[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 5000);
  const rows = await prisma.wbProduct.findMany({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  return rows.map((p) =>
    normalizeWbProductFromDb(p, {
      buyerFinalRub: p.lastWalletObservedRub ?? p.lastRegularObservedRub,
    }),
  );
}
