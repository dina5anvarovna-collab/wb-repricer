/**
 * Анонимный HTTP-клиент card.wb.ru — без Playwright, без куков, без авторизации.
 *
 * Поддерживает два формата ответа:
 *
 * v2 format (appType=1, /cards/v2/detail):
 *   - top-level priceU, salePriceU
 *   - extended.clientPriceU (с Кошельком), extended.basicPriceU (только SPP)
 *
 * v4 format (/cards/v4/detail) — используется с серверных IP:
 *   - sizes[N].price.basic  = priceU (до скидки продавца)
 *   - sizes[N].price.product = итоговая цена покупателя (с seller discount + SPP + wallet)
 *   - Нет отдельных clientPriceU / basicPriceU / salePriceU
 *
 * Fallback-цепочка для clientPriceRub:
 *   extended.clientPriceU (v2, лучший)
 *   → sizes[N].price.product (v4, buyer price after all discounts)
 *   → extended.basicPriceU (v2, без wallet)
 *   → salePriceU (v2, без SPP — консервативный)
 */

import { logger } from "./logger.js";

const CARD_BASE = "https://card.wb.ru";
const ENDPOINTS = ["/cards/v2/detail", "/cards/v4/detail"] as const;

/** Результат одного запроса card.wb.ru для конкретного dest. */
export type CardWbProbeResult = {
  /** Итоговая цена покупателя с WB Кошельком (или лучший доступный), руб. null если не удалось. */
  clientPriceRub: number | null;
  /** Цена без WB Кошелька (с SPP только), руб. Может быть null если v4-формат. */
  basicPriceRub: number | null;
  /** Эффективная цена продавца (salePriceU) — до SPP и Кошелька, руб. */
  sellerEffectiveRub: number | null;
  /** Исходная цена продавца (priceU) до его собственной скидки, руб. */
  basePriceRub: number | null;
  /** true если clientPriceRub получен из fallback, а не из clientPriceU */
  clientPriceIsFallback: boolean;
  httpStatus: number;
  endpoint: string;
  dest: string;
};

function safeRub(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  // WB отдаёт значения в копейках (× 100) если > 30 000
  return raw >= 30_000 ? Math.round(raw / 100) : Math.round(raw);
}

/**
 * Парсит v2-формат ответа (extended.clientPriceU, top-level priceU/salePriceU).
 */
function extractV2(
  row: Record<string, unknown>,
  nmId: number,
): Omit<CardWbProbeResult, "httpStatus" | "endpoint" | "dest"> | null {
  const id = Number(row.id);
  if (Number.isFinite(id) && id !== nmId) return null;

  const ext = row.extended as Record<string, unknown> | undefined;
  const clientPriceRubDirect = safeRub(ext?.clientPriceU);
  const basicPriceRub = safeRub(ext?.basicPriceU);
  const sellerEffectiveRub = safeRub(row.salePriceU);
  const basePriceRub = safeRub(row.priceU);

  // Нет ни одного полезного поля
  if (
    clientPriceRubDirect == null &&
    basicPriceRub == null &&
    sellerEffectiveRub == null &&
    basePriceRub == null
  )
    return null;

  // Fallback chain
  let clientPriceRub: number | null = clientPriceRubDirect;
  let clientPriceIsFallback = false;

  if (clientPriceRub == null) {
    if (basicPriceRub != null) {
      clientPriceRub = basicPriceRub;
      clientPriceIsFallback = true;
    } else if (sellerEffectiveRub != null) {
      clientPriceRub = sellerEffectiveRub;
      clientPriceIsFallback = true;
    }
  }

  if (clientPriceRub == null) return null;

  return { clientPriceRub, basicPriceRub, sellerEffectiveRub, basePriceRub, clientPriceIsFallback };
}

/**
 * Парсит v4-формат ответа (sizes[N].price.product, sizes[N].price.basic).
 * В v4 нет salePriceU и extended — только итоговая buyer-цена.
 */
function extractV4(
  row: Record<string, unknown>,
  nmId: number,
): Omit<CardWbProbeResult, "httpStatus" | "endpoint" | "dest"> | null {
  const id = Number(row.id);
  if (Number.isFinite(id) && id !== nmId) return null;

  const sizes = row.sizes as Array<Record<string, unknown>> | undefined;
  if (!sizes || sizes.length === 0) return null;

  // Берём первый размер с ненулевой ценой
  let clientPriceRub: number | null = null;
  let basePriceRub: number | null = null;

  for (const size of sizes) {
    const price = size.price as Record<string, unknown> | undefined;
    if (!price) continue;
    const product = safeRub(price.product);
    const basic = safeRub(price.basic);
    if (product != null) {
      clientPriceRub = product;
      basePriceRub = basic;
      break;
    }
  }

  if (clientPriceRub == null) return null;

  return {
    clientPriceRub,
    basicPriceRub: null,       // v4 не предоставляет отдельно SPP-цену без кошелька
    sellerEffectiveRub: null,  // v4 не предоставляет salePriceU
    basePriceRub,
    clientPriceIsFallback: false, // product в v4 — это и есть итоговая buyer-цена
  };
}

function parseCardResponse(
  body: unknown,
  nmId: number,
  endpoint: string,
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

  // Используем нужный парсер в зависимости от версии endpoint
  if (endpoint === "/cards/v4/detail") {
    // Сначала пробуем v4-формат, fallback на v2 если v4-поля пустые
    const v4 = extractV4(row, nmId);
    if (v4) return v4;
    return extractV2(row, nmId);
  }

  return extractV2(row, nmId);
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
    clientPriceIsFallback: false,
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
        logger.warn({ tag: "card_wb_429", nmId, dest, endpoint }, "card.wb.ru 429 — пробуем следующий endpoint");
        continue;
      }
      if (!res.ok) {
        logger.warn({ tag: "card_wb_error", nmId, dest, endpoint, status: res.status }, "card.wb.ru не 200");
        continue;
      }

      const json: unknown = await res.json();
      const parsed = parseCardResponse(json, nmId, endpoint);
      if (!parsed) {
        logger.warn({ tag: "card_wb_no_price", nmId, dest, endpoint }, "card.wb.ru: цена не найдена в ответе");
        continue;
      }

      if (parsed.clientPriceIsFallback) {
        logger.info(
          { tag: "card_wb_fallback", nmId, dest, endpoint, clientPriceRub: parsed.clientPriceRub },
          "clientPriceRub — fallback (используем лучшую доступную цену)",
        );
      }

      logger.debug(
        { tag: "card_wb_ok", nmId, dest, endpoint, ...parsed },
        "card.wb.ru: цена получена",
      );

      return { ...base, ...parsed, httpStatus, endpoint };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ tag: "card_wb_fetch_error", nmId, dest, endpoint, err: msg }, "card.wb.ru fetch error");
      httpStatus = 0;
    }
  }

  return { ...base, httpStatus: 0, endpoint: "none" };
}
