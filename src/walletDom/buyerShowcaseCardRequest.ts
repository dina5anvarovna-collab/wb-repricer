/**
 * Парсинг JSON ответов card.wb.ru (без сетевых вызовов).
 * HTTP + ретраи — в priceSourceResolver.ts.
 */

function rubFromWbPriceField(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  if (raw >= 300 * 100) {
    return Math.round(raw / 100);
  }
  return Math.round(raw);
}

function productsArrayFromCardJson(data: unknown): Record<string, unknown>[] | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const o = data as Record<string, unknown>;
  const dataBlock = o.data;
  if (dataBlock && typeof dataBlock === "object") {
    const inner = (dataBlock as Record<string, unknown>).products;
    if (Array.isArray(inner) && inner.length) {
      return inner as Record<string, unknown>[];
    }
  }
  if (Array.isArray(o.products) && o.products.length) {
    return o.products as Record<string, unknown>[];
  }
  return null;
}

function pickPriceFromSizeEntry(size: Record<string, unknown>): number | null {
  const price = size.price as Record<string, unknown> | undefined;
  if (price && typeof price === "object") {
    const product = rubFromWbPriceField(price.product);
    const total = rubFromWbPriceField(price.total);
    const basic = rubFromWbPriceField(price.basic);
    const log = product ?? total ?? basic;
    if (log != null) {
      return log;
    }
  }
  const priceU = rubFromWbPriceField(size.priceU);
  if (priceU != null) {
    return priceU;
  }
  const saleU = rubFromWbPriceField(size.salePriceU);
  if (saleU != null) {
    return saleU;
  }
  return null;
}

function pickPriceFromProductRow(row: Record<string, unknown>, nmId: number): number | null {
  const saleRoot = rubFromWbPriceField(row.salePriceU) ?? rubFromWbPriceField(row.priceU);
  if (saleRoot != null) {
    return saleRoot;
  }
  const totalRoot = rubFromWbPriceField(row.totalPrice);
  if (totalRoot != null) {
    return totalRoot;
  }

  const sizes = row.sizes;
  if (!Array.isArray(sizes) || !sizes.length) {
    return null;
  }
  for (const sz of sizes) {
    if (!sz || typeof sz !== "object") {
      continue;
    }
    const p = pickPriceFromSizeEntry(sz as Record<string, unknown>);
    if (p != null) {
      return p;
    }
  }
  const id = Number(row.id);
  if (Number.isFinite(id) && id === nmId) {
    return null;
  }
  return null;
}

export function parseShowcaseRubFromCardDetailJson(data: unknown, nmId: number): number | null {
  const products = productsArrayFromCardJson(data);
  if (!products?.length) {
    return null;
  }
  const byId = products.find((p) => Number(p.id) === nmId);
  const row = byId ?? products[0]!;
  return pickPriceFromProductRow(row, nmId);
}

/**
 * То же, что parseShowcaseRubFromCardDetailJson, плюс поиск объекта товара с id/nmId в глубине JSON
 * (другая форма ответа SPA / батч-запросов).
 */
function deepFindPriceForNmId(node: unknown, nmId: number, depth: number): number | null {
  if (depth > 18) {
    return null;
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    const pid = Number(o.id ?? o.nmId ?? o.nmID);
    if (Number.isFinite(pid) && pid === nmId) {
      const p = pickPriceFromProductRow(o, nmId);
      if (p != null) {
        return p;
      }
    }
    for (const v of Object.values(o)) {
      const found = deepFindPriceForNmId(v, nmId, depth + 1);
      if (found != null) {
        return found;
      }
    }
  }
  if (Array.isArray(node)) {
    for (const x of node) {
      const found = deepFindPriceForNmId(x, nmId, depth + 1);
      if (found != null) {
        return found;
      }
    }
  }
  return null;
}

export function parseShowcaseRubFromCardDetailJsonOrNested(data: unknown, nmId: number): number | null {
  const direct = parseShowcaseRubFromCardDetailJson(data, nmId);
  if (direct != null) {
    return direct;
  }
  return deepFindPriceForNmId(data, nmId, 0);
}

function isWarehouseLikeKey(k: string): boolean {
  return /warehouse|warehouses|whQty/i.test(k);
}

/** Имя поля в JSON похоже на цену кошелька (не warehouse / не общий product). */
function looksLikeWalletPriceKey(k: string): boolean {
  if (isWarehouseLikeKey(k)) return false;
  const kl = k.toLowerCase();
  if (kl.includes("кошел")) return true;
  if (!kl.includes("wallet")) return false;
  if (kl.includes("warehouse")) return false;
  return true;
}

function tryWalletRubFromRecord(o: Record<string, unknown>, depth: number): number | null {
  if (depth > 6) return null;
  for (const [k, v] of Object.entries(o)) {
    if (looksLikeWalletPriceKey(k)) {
      const n = rubFromWbPriceField(v);
      if (n != null && n > 0) return n;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = tryWalletRubFromRecord(v as Record<string, unknown>, depth + 1);
      if (inner != null) return inner;
    }
  }
  return null;
}

function pickWalletFromSizeEntry(size: Record<string, unknown>): number | null {
  const price = size.price;
  if (price && typeof price === "object") {
    const w = tryWalletRubFromRecord(price as Record<string, unknown>, 0);
    if (w != null) return w;
  }
  return tryWalletRubFromRecord(size, 0);
}

function pickWalletFromProductRow(row: Record<string, unknown>): number | null {
  const sizes = row.sizes;
  if (Array.isArray(sizes)) {
    for (const sz of sizes) {
      if (sz && typeof sz === "object") {
        const w = pickWalletFromSizeEntry(sz as Record<string, unknown>);
        if (w != null) return w;
      }
    }
  }
  return tryWalletRubFromRecord(row, 0);
}

/** Цена WB Кошелька из ответа card.wb.ru (если WB отдаёт отдельное поле при авторизованной сессии). */
export function parseWalletRubFromCardDetailJson(data: unknown, nmId: number): number | null {
  const products = productsArrayFromCardJson(data);
  if (!products?.length) {
    return null;
  }
  const byId = products.find((p) => Number(p.id) === nmId);
  const row = byId ?? products[0]!;
  return pickWalletFromProductRow(row);
}

function deepFindWalletForNmId(node: unknown, nmId: number, depth: number): number | null {
  if (depth > 18) {
    return null;
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    const pid = Number(o.id ?? o.nmId ?? o.nmID);
    if (Number.isFinite(pid) && pid === nmId) {
      return pickWalletFromProductRow(o);
    }
    for (const v of Object.values(o)) {
      const found = deepFindWalletForNmId(v, nmId, depth + 1);
      if (found != null) {
        return found;
      }
    }
  }
  if (Array.isArray(node)) {
    for (const x of node) {
      const found = deepFindWalletForNmId(x, nmId, depth + 1);
      if (found != null) {
        return found;
      }
    }
  }
  return null;
}

export function parseWalletRubFromCardDetailJsonOrNested(data: unknown, nmId: number): number | null {
  const direct = parseWalletRubFromCardDetailJson(data, nmId);
  if (direct != null) {
    return direct;
  }
  return deepFindWalletForNmId(data, nmId, 0);
}
