import { prisma as db } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { getActiveCabinetToken, syncCatalogFromSeller } from "../catalogSync/syncCatalog.js";
import { syncSellerApiAuthMeta } from "../wbSession/sessionManager.js";

const TAG = "wb-sync";

async function loadCabinetProductSnapshot(cabinetId: string) {
  return db.wbProduct.findMany({
    where: { cabinetId, isActive: true },
    select: {
      id: true,
      nmId: true,
      sellerPrice: true,
      discountedPriceRub: true,
      stock: true,
    },
  });
}

async function snapshotPricesOnly(cabinetId: string, source: string): Promise<{ prices: number }> {
  const products = await loadCabinetProductSnapshot(cabinetId);
  const now = new Date();
  const priceRows = products.map((p) => ({
    productId: p.id,
    nmId: p.nmId,
    sellerPrice: p.sellerPrice,
    discountedPrice: p.discountedPriceRub,
    buyerFinalRub: null as number | null,
    sppPercent: null as number | null,
    source,
    createdAt: now,
  }));
  if (!priceRows.length) {
    return { prices: 0 };
  }
  await db.productPriceRecord.createMany({ data: priceRows });
  return { prices: priceRows.length };
}

async function snapshotStocksOnly(cabinetId: string, source: string): Promise<{ stocks: number }> {
  const products = await loadCabinetProductSnapshot(cabinetId);
  const now = new Date();
  const stockRows = products.map((p) => ({
    productId: p.id,
    nmId: p.nmId,
    warehouseId: "total",
    warehouseName: "Всего (кабинет)",
    quantity: p.stock ?? 0,
    capturedAt: now,
  }));
  if (!stockRows.length) {
    return { stocks: 0 };
  }
  await db.productStockLine.createMany({ data: stockRows });
  return { stocks: stockRows.length };
}

export async function runUnifiedSync(scope: "all" | "stocks" | "prices"): Promise<{
  logId: string;
  ok: boolean;
  message?: string;
  upserted?: number;
  snapshotPrices?: number;
  snapshotStocks?: number;
}> {
  const log = await db.syncRunLog.create({
    data: { scope, status: "running", message: null },
  });
  try {
    const auth = await getActiveCabinetToken();
    await syncSellerApiAuthMeta(auth?.token ?? null);
    if (!auth) {
      await db.syncRunLog.update({
        where: { id: log.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: "Нет токена Seller API — сохраните токен в «Подключение WB»",
        },
      });
      return { logId: log.id, ok: false, message: "Нет токена Seller API" };
    }

    const r = await syncCatalogFromSeller(auth.cabinetId, auth.token);
    const snap = { prices: 0, stocks: 0 };
    if (scope === "all" || scope === "prices") {
      snap.prices = (await snapshotPricesOnly(auth.cabinetId, scope === "all" ? "sync_all" : "sync_prices")).prices;
    }
    if (scope === "all" || scope === "stocks") {
      snap.stocks = (await snapshotStocksOnly(auth.cabinetId, scope === "all" ? "sync_all" : "sync_stocks")).stocks;
    }
    await db.syncRunLog.update({
      where: { id: log.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        message: JSON.stringify({ ...r, snapshot: snap }),
      },
    });
    logger.info({ tag: TAG, logId: log.id, upserted: r.upserted, snap }, "unified sync done");
    return {
      logId: log.id,
      ok: true,
      upserted: r.upserted,
      snapshotPrices: snap.prices,
      snapshotStocks: snap.stocks,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(e, "unified sync failed");
    await db.syncRunLog.update({
      where: { id: log.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: msg.slice(0, 2000) },
    });
    return { logId: log.id, ok: false, message: msg };
  }
}
