import path from "node:path";
import { env } from "../../config/env.js";
import { decryptToken, encryptToken, tokenLast4 } from "../../lib/crypto/tokenVault.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { runtimePaths } from "../../lib/runtimePaths.js";
import {
  fetchContentCardsMapBestEffort,
  fetchSellerPricesPage,
  normalizeSellerApiToken,
} from "../wbSellerApi/client.js";
import {
  applyAggregatedStocksToCabinet,
  fetchSupplierStocksAggregatedByNmId,
  type StatisticsStocksSyncResult,
} from "../wbSellerApi/statisticsStocks.js";

/** WB: limit ≤ 1000 на страницу; между страницами пауза из‑за rate limit (6 c / 10 req). */
const PAGE = 1000;
const PAGE_PAUSE_MS = 700;

function discountedAfterSellerDiscount(price: number | undefined, discountPct: number | undefined): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  const d = discountPct ?? 0;
  if (!Number.isFinite(d) || d <= 0 || d >= 100) {
    return Math.round(price);
  }
  return Math.round((price * (100 - d)) / 100);
}

/** Создать/обновить правило минимума (для защиты итоговой цены) */
export async function upsertMinPriceRule(
  productId: string,
  minAllowedFinalPrice: number,
  extra?: { comment?: string; controlEnabled?: boolean },
): Promise<void> {
  await prisma.minPriceRule.upsert({
    where: { productId },
    create: {
      productId,
      minAllowedFinalPrice,
      comment: extra?.comment ?? null,
      controlEnabled: extra?.controlEnabled ?? true,
    },
    update: {
      minAllowedFinalPrice,
      ...(extra?.comment !== undefined ? { comment: extra.comment } : {}),
      ...(extra?.controlEnabled !== undefined ? { controlEnabled: extra.controlEnabled } : {}),
    },
  });
}

/**
 * Сохраняет токен в БД (шифрование). Проверку WB выполняйте отдельно (`/api/settings/wb-token/test`),
 * иначе при сетевой ошибке или 429 токен не сохранится.
 */
export async function upsertSellerToken(rawToken: string, name = "default"): Promise<{ id: string; tokenLast4: string }> {
  const trimmed = normalizeSellerApiToken(rawToken);
  if (!trimmed) {
    throw new Error("Пустой токен");
  }
  const enc = encryptToken(trimmed, env.REPRICER_MASTER_SECRET);
  const last4 = tokenLast4(trimmed);
  let cabinet = await prisma.sellerCabinet.findFirst({ where: { isActive: true } });
  if (!cabinet) {
    cabinet = await prisma.sellerCabinet.create({
      data: { name, tokenEncrypted: enc, tokenLast4: last4, isActive: true },
    });
  } else {
    cabinet = await prisma.sellerCabinet.update({
      where: { id: cabinet.id },
      data: { tokenEncrypted: enc, tokenLast4: last4, isActive: true, name },
    });
  }
  logger.info({ cabinetId: cabinet.id, token: `…${last4}` }, "seller token stored (encrypted)");
  return { id: cabinet.id, tokenLast4: last4 };
}

export async function getActiveCabinetToken(): Promise<{ cabinetId: string; token: string } | null> {
  const c = await prisma.sellerCabinet.findFirst({ where: { isActive: true } });
  if (!c?.tokenEncrypted) return null;
  try {
    const token = decryptToken(c.tokenEncrypted, env.REPRICER_MASTER_SECRET);
    return { cabinetId: c.id, token };
  } catch {
    return null;
  }
}

export async function syncCatalogFromSeller(
  cabinetId: string,
  token: string,
): Promise<{
  upserted: number;
  pages: number;
  contentPagesOk: number;
  contentPagesFailed: number;
  enrichedFromContent: number;
  pricesOnlyCount: number;
  statisticsStocks: StatisticsStocksSyncResult;
}> {
  let offset = 0;
  let upserted = 0;
  let pages = 0;
  for (;;) {
    const { rows } = await fetchSellerPricesPage(token, offset, PAGE);
    pages += 1;
    if (!rows.length) break;
    for (const r of rows) {
      if (!Number.isFinite(r.nmId) || r.nmId <= 0) continue;
      const discountedPriceRub = discountedAfterSellerDiscount(r.price, r.discount);
      const fallbackTitle = `Товар ${r.nmId}`;
      await prisma.wbProduct.upsert({
        where: { cabinetId_nmId: { cabinetId, nmId: r.nmId } },
        create: {
          cabinetId,
          nmId: r.nmId,
          vendorCode: r.vendorCode ?? null,
          title: fallbackTitle,
          sellerPrice: r.price ?? null,
          sellerDiscount: r.discount ?? null,
          discountedPriceRub,
        },
        update: {
          vendorCode: r.vendorCode ?? null,
          sellerPrice: r.price ?? null,
          sellerDiscount: r.discount ?? null,
          discountedPriceRub,
        },
      });
      upserted += 1;
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
    await new Promise((r) => setTimeout(r, PAGE_PAUSE_MS));
  }

  let contentPagesOk = 0;
  let contentPagesFailed = 0;
  let enrichedFromContent = 0;
  const { byNmId, pagesOk, pagesFailed } = await fetchContentCardsMapBestEffort(token);
  contentPagesOk = pagesOk;
  contentPagesFailed = pagesFailed;

  const cabinetProducts = await prisma.wbProduct.findMany({
    where: { cabinetId },
    select: { id: true, nmId: true, vendorCode: true },
  });
  const now = new Date();
  for (const p of cabinetProducts) {
    const card = byNmId.get(p.nmId);
    if (!card) continue;
    enrichedFromContent += 1;
    await prisma.wbProduct.update({
      where: { id: p.id },
      data: {
        title: card.title,
        brand: card.brand ?? null,
        subjectName: card.subjectName ?? null,
        vendorCode: card.vendorCode ?? p.vendorCode,
        contentEnrichedAt: now,
      },
    });
  }
  const pricesOnlyCount = cabinetProducts.length - enrichedFromContent;

  const stFlag = env.REPRICER_SYNC_STATISTICS_STOCKS.trim().toLowerCase();
  const statisticsStocksEnabled = !["0", "false", "no", "off"].includes(stFlag);

  let statisticsStocks: StatisticsStocksSyncResult = {
    ok: true,
    pages: 0,
    nmIdsWithStock: 0,
    totalQuantityApprox: 0,
    skipped: true,
    message: "REPRICER_SYNC_STATISTICS_STOCKS отключён",
  };

  if (statisticsStocksEnabled) {
    const statsToken = env.REPRICER_WB_STATISTICS_TOKEN.trim() || token;
    const { byNmId, pages: stPages, error, httpStatus } = await fetchSupplierStocksAggregatedByNmId(
      statsToken,
      { pauseBetweenPagesMs: env.REPRICER_WB_STATISTICS_PAUSE_MS },
    );
    const totalQ = [...byNmId.values()].reduce((a, b) => a + b, 0);

    if (error === "forbidden") {
      statisticsStocks = {
        ok: false,
        pages: stPages,
        nmIdsWithStock: byNmId.size,
        totalQuantityApprox: totalQ,
        skipped: false,
        httpStatus,
        message:
          "Statistics API (остатки): 401/403 — к API-ключу нужна категория «Статистика» или задайте REPRICER_WB_STATISTICS_TOKEN.",
      };
      logger.warn({ cabinetId, httpStatus }, statisticsStocks.message);
    } else if (error === "rate_limit") {
      statisticsStocks = {
        ok: false,
        pages: stPages,
        nmIdsWithStock: byNmId.size,
        totalQuantityApprox: totalQ,
        skipped: false,
        httpStatus,
        message: "Statistics API: 429, остатки не обновлены.",
      };
      logger.warn({ cabinetId }, statisticsStocks.message);
    } else if (error) {
      statisticsStocks = {
        ok: false,
        pages: stPages,
        nmIdsWithStock: byNmId.size,
        totalQuantityApprox: totalQ,
        skipped: false,
        httpStatus,
        message: `Statistics stocks: ${error}`,
      };
      logger.warn({ cabinetId, error, httpStatus }, "catalog sync: остатки не подтянуты");
    } else if (byNmId.size > 0 || stPages > 1) {
      await applyAggregatedStocksToCabinet(cabinetId, byNmId);
      statisticsStocks = {
        ok: true,
        pages: stPages,
        nmIdsWithStock: byNmId.size,
        totalQuantityApprox: totalQ,
        skipped: false,
      };
      logger.info(
        { cabinetId, stPages, nmIds: byNmId.size, totalQuantityApprox: totalQ },
        "catalog sync: остатки обновлены (Statistics API)",
      );
    } else {
      statisticsStocks = {
        ok: true,
        pages: stPages,
        nmIdsWithStock: 0,
        totalQuantityApprox: 0,
        skipped: true,
        message:
          "Statistics: пустой ответ на первом запросе — поле stock в БД не меняли (проверьте права «Статистика» или повторите позже).",
      };
      logger.warn({ cabinetId }, statisticsStocks.message ?? "statistics stocks empty");
    }
  }

  logger.info(
    {
      cabinetId,
      upserted,
      pages,
      contentPagesOk,
      contentPagesFailed,
      enrichedFromContent,
      pricesOnlyCount,
      statisticsStocks,
    },
    "catalog sync: prices + content enrichment",
  );
  return {
    upserted,
    pages,
    contentPagesOk,
    contentPagesFailed,
    enrichedFromContent,
    pricesOnlyCount,
    statisticsStocks,
  };
}

/** Resolve absolute path to Playwright userDataDir for wallet CLI */
export function resolveBuyerProfileDir(): string {
  const raw = env.BUYER_PROFILE_DIR || env.REPRICER_BUYER_PROFILE_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(runtimePaths.projectRoot, raw);
}
