/**
 * Анонимный HTTP-клиент card.wb.ru — без Playwright, без куков, без авторизации.
 *
 * Возвращает clientPriceU (цена покупателя с WB Кошельком + SPP) и
 * basicPriceU (без WB Кошелька, только SPP).
 *
 * Важно: salePriceU из ответа card.wb.ru = эффективная цена продавца
 * (после его скидки, до WB-механизмов). Используем её как P_eff, если
 * Seller API недоступен.
 */

import { logger } from "./logger.js";

const CARD_BASE = "https://card.wb.ru";
const ENDPOINTS = ["/cards/v2/detail", "/cards/v4/detail"] as const;

/** Результат одного запроса card.wb.ru для конкретного dest. */
export type CardWbProbeResult = {
  /** Итоговая цена покупателя с WB Кошельком, руб. null если не удалось получить. */
  clientPriceRub: number | null;
  /** Цена без WB Кошелька (с SPP), руб. */
  basicPriceRub: number | null;
  /** Эффективная цена продавца (salePriceU) — до SPP и Кошелька, руб. */
  sellerEffectiveRub: number | null;
  /** Исходная цена продавца (priceU) до его собственной скидки, руб. */
  basePriceRub: number | null;
  httpStatus: number;
  endpoint: string;
  dest: string;
};

function safeRub(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  // WB отдаёт значения в копейках (× 100) если > 300 × 100 = 30 000
  return raw >= 30_000 ? Math.round(raw / 100) : Math.round(raw);
}

function extractFromProduct(
  row: Record<string, unknown>,
  nmId: number,
): Omit<CardWbProbeResult, "httpStatus" | "endpoint" | "dest"> | null {
  const id = Number(row.id);
  if (Number.isFinite(id) && id !== nmId) return null;

  // extended содержит clientPriceU и basicPriceU (WB Кошелёк и цена до него)
  const ext = row.extended as Record<string, unknown> | undefined;
  const clientPriceRub = safeRub(ext?.clientPriceU);
  const basicPriceRub = safeRub(ext?.basicPriceU);

  // salePriceU = effectiveCabinet (после скидки продавца, до SPP/Кошелька)
  const sellerEffectiveRub = safeRub(row.salePriceU);
  const basePriceRub = safeRub(row.priceU);

  if (clientPriceRub == null && basicPriceRub == null) return null;

  return { clientPriceRub, basicPriceRub, sellerEffectiveRub, basePriceRub };
}

function parseCardResponse(
  body: unknown,
  nmId: number,
): Omit<CardWbProbeResult, "httpStatus" | "endpoint" | "dest"> | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;

  let products: unknown[] | null = null;
  if (o.data && typeof o.data === "object") {
    const inner = (o.data as Record<string, unknown>).products;
    if (Array.isArray(inner) && inner.length) products = inner;
  }
  if (!products && Array.isArray(o.products) && o.products.length) {
    products = o.products;
  }
  if (!products) return null;

  // Ищем точное совпадение по id, иначе первый
  const byId = products.find((p) => Number((p as Record<string, unknown>).id) === nmId);
  const row = (byId ?? products[0]) as Record<string, unknown>;
  return extractFromProduct(row, nmId);
}

/**
 * Один GET к card.wb.ru для конкретного (nmId, dest).
 * Пробует /v2, при неудаче — /v4.
 * Не выбрасывает исключений: все ошибки возвращаются как null-поля.
 */
export async function probeCardWb(
  nmId: number,
  dest: string,
  timeoutMs = 8_000,
): Promise<CardWbProbeResult> {
  const base: Omit<CardWbProbeResult, "httpStatus" | "endpoint"> = {
    clientPriceRub: null,
    basicPriceRub: null,
    sellerEffectiveRub: null,
    basePriceRub: null,
    dest,
  };

  for (const endpoint of ENDPOINTS) {
    const url = `${CARD_BASE}${endpoint}?appType=1&curr=rub&dest=${encodeURIComponent(dest)}&nm=${nmId}`;
    let httpStatus = 0;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; WBRepricer/2.0)",
            Accept: "application/json",
          },
        });
      } finally {
        clearTimeout(timer);
      }
      httpStatus = res.status;

      if (res.status === 429) {
        // Rate-limit: пробуем следующий endpoint
        logger.warn({ tag: "card_wb_429", nmId, dest, endpoint }, "card.wb.ru 429 — пробуем следующий endpoint");
        continue;
      }
      if (!res.ok) {
        logger.warn({ tag: "card_wb_error", nmId, dest, endpoint, status: res.status }, "card.wb.ru не 200");
        continue;
      }

      const json: unknown = await res.json();
      const parsed = parseCardResponse(json, nmId);
      if (!parsed) {
        logger.warn({ tag: "card_wb_no_price", nmId, dest, endpoint }, "card.wb.ru: clientPriceU не найден");
        continue;
      }

      return { ...base, ...parsed, httpStatus, endpoint };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ tag: "card_wb_fetch_error", nmId, dest, endpoint, err: msg }, "card.wb.ru fetch error");
      httpStatus = 0;
    }
  }

  return { ...base, httpStatus: 0, endpoint: "none" };
}
