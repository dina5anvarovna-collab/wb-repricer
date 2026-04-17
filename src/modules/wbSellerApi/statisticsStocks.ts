/**
 * Остатки по складам WB — отдельный Statistics API (не discounts-prices).
 * Документация: https://dev.wildberries.ru/openapi/reports/ — GET /api/v1/supplier/stocks
 * Лимит: 1 запрос / минуту на кабинет; метод помечен deprecated, но даёт полный снимок по dateFrom.
 */
import { prisma } from "../../lib/prisma.js";
import { normalizeSellerApiToken } from "./client.js";

const STATISTICS_BASE = "https://statistics-api.wildberries.ru";
const MAX_PAGES = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseStocksJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export type StatisticsStocksSyncResult = {
  ok: boolean;
  pages: number;
  nmIdsWithStock: number;
  totalQuantityApprox: number;
  skipped: boolean;
  message?: string;
  httpStatus?: number;
};

/**
 * Собирает сумму quantityFull (или quantity) по всем строкам отчёта, агрегируя по nmId.
 */
export async function fetchSupplierStocksAggregatedByNmId(
  token: string,
  opts?: { pauseBetweenPagesMs?: number },
): Promise<{
  byNmId: Map<number, number>;
  pages: number;
  httpStatus?: number;
  error?: string;
}> {
  const norm = normalizeSellerApiToken(token);
  if (!norm) {
    return { byNmId: new Map(), pages: 0, error: "empty_token" };
  }

  const pauseMs = Math.max(61_000, opts?.pauseBetweenPagesMs ?? 61_000);
  const byNmId = new Map<number, number>();
  let dateFrom = "2019-06-20";
  let pages = 0;

  for (let i = 0; i < MAX_PAGES; i += 1) {
    const url = `${STATISTICS_BASE}/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(dateFrom)}`;
    const res = await fetch(url, { headers: { Authorization: norm } });
    const text = await res.text();
    const parsed = parseStocksJson(text);

    if (res.status === 401 || res.status === 403) {
      return {
        byNmId,
        pages,
        httpStatus: res.status,
        error: "forbidden",
      };
    }
    if (res.status === 429) {
      return {
        byNmId,
        pages,
        httpStatus: res.status,
        error: "rate_limit",
      };
    }
    if (!res.ok) {
      return {
        byNmId,
        pages,
        httpStatus: res.status,
        error: text.slice(0, 200) || `http_${res.status}`,
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        byNmId,
        pages,
        httpStatus: res.status,
        error: "not_array",
      };
    }

    pages += 1;

    if (parsed.length === 0) {
      break;
    }

    for (const row of parsed as Array<Record<string, unknown>>) {
      const nmId = Number(row.nmId ?? row.nmID);
      const qtyRaw = row.quantityFull ?? row.quantity;
      const qty =
        typeof qtyRaw === "number"
          ? qtyRaw
          : typeof qtyRaw === "string"
            ? Number(String(qtyRaw).replace(",", "."))
            : NaN;
      if (!Number.isFinite(nmId) || nmId <= 0) continue;
      if (!Number.isFinite(qty) || qty < 0) continue;
      const q = Math.round(qty);
      byNmId.set(nmId, (byNmId.get(nmId) ?? 0) + q);
    }

    const last = parsed[parsed.length - 1] as Record<string, unknown> | undefined;
    const next =
      last && typeof last.lastChangeDate === "string" && last.lastChangeDate.trim()
        ? last.lastChangeDate.trim()
        : null;
    if (!next || next === dateFrom) {
      break;
    }
    dateFrom = next;
    await sleep(pauseMs);
  }

  return { byNmId, pages, httpStatus: 200 };
}

/**
 * Обнуляет остатки по кабинету и выставляет суммы из отчёта статистики по nmId.
 */
export async function applyAggregatedStocksToCabinet(
  cabinetId: string,
  byNmId: Map<number, number>,
): Promise<void> {
  await prisma.$executeRaw`UPDATE WbProduct SET stock = 0 WHERE cabinetId = ${cabinetId}`;
  const entries = [...byNmId.entries()];
  const CHUNK = 150;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map(([nmId, qty]) =>
        prisma.wbProduct.updateMany({
          where: { cabinetId, nmId },
          data: { stock: qty },
        }),
      ),
    );
  }
}

