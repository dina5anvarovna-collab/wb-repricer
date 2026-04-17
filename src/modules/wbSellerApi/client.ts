/**
 * Seller API: list goods / prices — token used only here, never for wallet price.
 *
 * Документация WB: токен передаётся в заголовке Authorization как есть (без обязательного префикса Bearer).
 * https://dev.wildberries.ru/openapi/api-information — раздел Authorization.
 */
const PRICES_BASE = "https://discounts-prices-api.wildberries.ru";
const CONTENT_BASE = "https://content-api.wildberries.ru";

/** Убрать BOM, пробелы по краям; опционально снять один префикс «Bearer ». Внутренние пробелы не трогаем. */
export function normalizeSellerApiToken(raw: string): string {
  let t = raw.replace(/^\uFEFF/, "").trim();
  const m = t.match(/^Bearer\s+(.+)$/is);
  if (m) {
    t = m[1].trim();
  }
  return t;
}

type WbJsonEnvelope = {
  error?: boolean;
  errorText?: string;
  data?: unknown;
};

function parseWbJson(text: string): WbJsonEnvelope | null {
  try {
    return JSON.parse(text) as WbJsonEnvelope;
  } catch {
    return null;
  }
}

/** Часто WB отвечает 200 и error:true (неверная категория токена и т.д.). */
function throwIfWbEnvelopeError(
  res: Response,
  parsed: WbJsonEnvelope | null,
  fallbackStatus: number,
): void {
  if (parsed?.error === true) {
    const msg =
      (typeof parsed.errorText === "string" && parsed.errorText.trim()) ||
      "Ошибка WB API. Для цен и скидок нужен токен категории «Цены и скидки» в настройках продавца.";
    throw new WbSellerApiError(msg, res.status || fallbackStatus);
  }
}

export class WbSellerApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WbSellerApiError";
  }
}

export async function validateSellerToken(token: string): Promise<void> {
  const norm = normalizeSellerApiToken(token);
  if (!norm) {
    throw new WbSellerApiError("Пустой токен");
  }
  const url = `${PRICES_BASE}/api/v2/list/goods/filter?limit=1&offset=0`;
  const res = await fetch(url, {
    headers: { Authorization: norm },
  });
  const text = await res.text();
  const parsed = parseWbJson(text);

  throwIfWbEnvelopeError(res, parsed, res.status);

  if (res.status === 401 || res.status === 403) {
    throw new WbSellerApiError(
      "WB отклонил токен (401/403). Создайте токен с доступом к категории «Цены и скидки» и вставьте его целиком в поле Authorization (без лишних пробелов и кавычек).",
      res.status,
    );
  }
  if (!res.ok) {
    const hint = parsed?.errorText?.trim() || text.slice(0, 300);
    throw new WbSellerApiError(
      `WB prices API: ${res.status} ${res.statusText}${hint ? ` — ${hint}` : ""}`,
      res.status,
    );
  }
}

export type SellerPriceRow = {
  nmId: number;
  vendorCode?: string;
  price?: number;
  discount?: number;
};

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** WB отдаёт цену на карточке или внутри sizes[0] (см. openapi «Prices and Discounts»). */
function extractListGoods(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") {
    return [];
  }
  const d = data as Record<string, unknown>;
  const lg = d.listGoods;
  if (Array.isArray(lg)) {
    return lg as Array<Record<string, unknown>>;
  }
  const goods = d.goods;
  if (Array.isArray(goods)) {
    return goods as Array<Record<string, unknown>>;
  }
  return [];
}

export function mapWbListGoodToSellerRow(g: Record<string, unknown>): SellerPriceRow | null {
  const nmId = Number(g.nmID ?? g.nmId);
  if (!Number.isFinite(nmId) || nmId <= 0) {
    return null;
  }

  let price = toFiniteNumber(g.price);
  let discount = toFiniteNumber(g.discount);

  const sizes = g.sizes;
  if (Array.isArray(sizes) && sizes.length > 0) {
    const s0 = sizes[0] as Record<string, unknown>;
    if (price == null) {
      price = toFiniteNumber(s0.price);
    }
    if (discount == null) {
      discount = toFiniteNumber(s0.discount);
    }
  }

  const vendorCode = typeof g.vendorCode === "string" ? g.vendorCode : undefined;

  const row: SellerPriceRow = { nmId, vendorCode };
  if (price != null) {
    row.price = price;
  }
  if (discount != null) {
    row.discount = Math.round(discount);
  }
  return row;
}

/** Текущая цена и скидка в кабинете по одному nmId (filterNmID). */
export async function fetchGoodsPriceByNmId(
  token: string,
  nmId: number,
): Promise<{ nmID: number; price: number; discount: number } | null> {
  const norm = normalizeSellerApiToken(token);
  const path = `/api/v2/list/goods/filter?limit=10&offset=0&filterNmID=${encodeURIComponent(String(nmId))}`;
  const res = await fetch(`${PRICES_BASE}${path}`, {
    headers: { Authorization: norm },
  });
  const text = await res.text();
  const data = parseWbJson(text);
  throwIfWbEnvelopeError(res, data, res.status);
  if (!res.ok) {
    throw new WbSellerApiError(`WB prices nmId=${nmId}: ${res.status}`, res.status);
  }
  if (!data) {
    throw new WbSellerApiError(`WB prices nmId=${nmId}: невалидный JSON`, res.status);
  }
  if (data.error) {
    throw new WbSellerApiError(data.errorText ?? "WB prices API error", res.status);
  }
  const listGoods = extractListGoods(data.data);
  const g = listGoods[0];
  if (!g) {
    return null;
  }
  const row = mapWbListGoodToSellerRow(g);
  if (!row || row.price == null || !Number.isFinite(row.price) || row.price <= 0) {
    return null;
  }
  const nmID = row.nmId;
  const price = Math.round(row.price);
  const discount = row.discount ?? 0;
  return { nmID, price, discount };
}

/**
 * Установка цен и скидок (до 1000 номенклатур за запрос).
 * price — цена до скидки в рублях (целое), discount — процент скидки 0..99.
 */
export async function uploadGoodsPricesTask(
  token: string,
  rows: Array<{ nmID: number; price: number; discount: number }>,
): Promise<{ id: number; alreadyExists?: boolean }> {
  if (rows.length === 0) {
    throw new WbSellerApiError("upload: empty data");
  }
  if (rows.length > 1000) {
    throw new WbSellerApiError("upload: max 1000 rows per request");
  }
  const norm = normalizeSellerApiToken(token);
  const res = await fetch(`${PRICES_BASE}/api/v2/upload/task`, {
    method: "POST",
    headers: {
      Authorization: norm,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: rows.map((r) => ({
        nmID: r.nmID,
        price: Math.round(r.price),
        discount: Math.min(99, Math.max(0, Math.round(r.discount))),
      })),
    }),
  });
  const text = await res.text();
  const raw = parseWbJson(text) as
    | {
        data?: { id?: number; alreadyExists?: boolean };
        error?: boolean;
        errorText?: string;
      }
    | null;
  throwIfWbEnvelopeError(res, raw, res.status);
  if (!res.ok) {
    throw new WbSellerApiError(
      raw?.errorText ?? `WB upload: ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  if (!raw || raw.error || raw.data?.id == null) {
    throw new WbSellerApiError(raw?.errorText ?? "WB upload: no task id", res.status);
  }
  return { id: raw.data.id, alreadyExists: raw.data.alreadyExists };
}

/** Товары в карантине цен WB (резкое снижение) */
export async function fetchQuarantineGoodsPage(
  token: string,
  offset: number,
  limit: number,
): Promise<{ nmIds: number[]; raw: unknown }> {
  const norm = normalizeSellerApiToken(token);
  const path = `/api/v2/quarantine/goods?offset=${offset}&limit=${limit}`;
  const res = await fetch(`${PRICES_BASE}${path}`, {
    headers: { Authorization: norm },
  });
  const text = await res.text();
  const data = parseWbJson(text);
  throwIfWbEnvelopeError(res, data, res.status);
  if (!res.ok) {
    throw new WbSellerApiError(`WB quarantine: ${res.status}`, res.status);
  }
  const goods = (data?.data as { quarantineGoods?: Array<Record<string, unknown>> } | undefined)
    ?.quarantineGoods ?? [];
  const nmIds = goods
    .map((g) => Number(g.nmID ?? g.nmId))
    .filter((n) => Number.isFinite(n));
  return { nmIds, raw: data };
}

export async function fetchSellerPricesPage(
  token: string,
  offset: number,
  limit: number,
): Promise<{ rows: SellerPriceRow[]; total?: number }> {
  const norm = normalizeSellerApiToken(token);
  const path = `/api/v2/list/goods/filter?limit=${limit}&offset=${offset}`;
  const res = await fetch(`${PRICES_BASE}${path}`, {
    headers: { Authorization: norm },
  });
  const text = await res.text();
  const envelope = parseWbJson(text);
  throwIfWbEnvelopeError(res, envelope, res.status);
  if (!res.ok) {
    throw new WbSellerApiError(
      envelope?.errorText ?? `WB prices: ${res.status}`,
      res.status,
    );
  }
  if (!envelope) {
    throw new WbSellerApiError(`WB prices: невалидный ответ`, res.status);
  }
  const list = extractListGoods(envelope.data);
  const rows: SellerPriceRow[] = [];
  for (const g of list) {
    const row = mapWbListGoodToSellerRow(g);
    if (row) {
      rows.push(row);
    }
  }
  return { rows };
}

export type ContentCard = {
  nmId: number;
  title: string;
  brand?: string;
  subjectName?: string;
  vendorCode?: string;
};

/** WB часто кладёт cards внутрь `data`; поддерживаем оба варианта корня. */
function extractContentListPayload(envelope: unknown): {
  cards: Array<Record<string, unknown>>;
  cursor?: { updatedAt: string; nmID: number };
} {
  if (!envelope || typeof envelope !== "object") {
    return { cards: [] };
  }
  const root = envelope as Record<string, unknown>;
  let node: Record<string, unknown> = root;
  const nested = root.data;
  if (nested && typeof nested === "object") {
    node = nested as Record<string, unknown>;
  }
  const cardsRaw = node.cards;
  const cards = Array.isArray(cardsRaw) ? (cardsRaw as Array<Record<string, unknown>>) : [];
  const cur = node.cursor as Record<string, unknown> | undefined;
  const next =
    cur && typeof cur.updatedAt === "string" && cur.nmID !== undefined && cur.nmID !== null
      ? { updatedAt: String(cur.updatedAt), nmID: Number(cur.nmID) }
      : undefined;
  return { cards, cursor: next };
}

function mapRawCardToContentCard(c: Record<string, unknown>): ContentCard | null {
  const nmId = Number(c.nmID ?? c.nmId);
  if (!Number.isFinite(nmId) || nmId <= 0) {
    return null;
  }
  const title = String(c.title ?? "").trim();
  return {
    nmId,
    title: title || `Товар ${nmId}`,
    brand: typeof c.brand === "string" ? c.brand : undefined,
    subjectName: typeof c.subjectName === "string" ? c.subjectName : undefined,
    vendorCode: typeof c.vendorCode === "string" ? c.vendorCode : undefined,
  };
}

export async function fetchContentCardsPage(
  token: string,
  cursor?: { updatedAt?: string; nmID?: number },
): Promise<{ cards: ContentCard[]; cursor?: { updatedAt: string; nmID: number } }> {
  const norm = normalizeSellerApiToken(token);
  const body: Record<string, unknown> = {
    settings: {
      cursor: cursor
        ? { updatedAt: cursor.updatedAt, nmID: cursor.nmID }
        : { limit: 100 },
      filter: { withPhoto: -1 },
    },
  };
  const res = await fetch(`${CONTENT_BASE}/content/v2/get/cards/list`, {
    method: "POST",
    headers: {
      Authorization: norm,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = parseWbJson(text);
  throwIfWbEnvelopeError(res, parsed, res.status);
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "errorText" in parsed
        ? String((parsed as { errorText?: string }).errorText ?? "")
        : "") || `WB content: ${res.status}`;
    throw new WbSellerApiError(msg, res.status);
  }
  const { cards: rawList, cursor: next } = extractContentListPayload(parsed);
  const cards: ContentCard[] = [];
  for (const c of rawList) {
    const row = mapRawCardToContentCard(c);
    if (row) {
      cards.push(row);
    }
  }
  return { cards, cursor: next };
}

const CONTENT_PAGE_PAUSE_MS = 700;

/**
 * Все карточки контента кабинета (для обогащения каталога). Ошибка одной страницы не рвёт весь проход —
 * возвращаем частичную карту и счётчик сбоев.
 */
export async function fetchContentCardsMapBestEffort(
  token: string,
  opts?: { maxPages?: number },
): Promise<{ byNmId: Map<number, ContentCard>; pagesOk: number; pagesFailed: number }> {
  const maxPages = Math.min(opts?.maxPages ?? 400, 500);
  const byNmId = new Map<number, ContentCard>();
  let cursor: { updatedAt: string; nmID: number } | undefined;
  let pagesOk = 0;
  let pagesFailed = 0;
  for (let i = 0; i < maxPages; i += 1) {
    try {
      const page = await fetchContentCardsPage(
        token,
        cursor ? { updatedAt: cursor.updatedAt, nmID: cursor.nmID } : undefined,
      );
      pagesOk += 1;
      for (const c of page.cards) {
        byNmId.set(c.nmId, c);
      }
      if (!page.cursor) {
        break;
      }
      cursor = page.cursor;
      await new Promise((r) => setTimeout(r, CONTENT_PAGE_PAUSE_MS));
    } catch {
      pagesFailed += 1;
      break;
    }
  }
  return { byNmId, pagesOk, pagesFailed };
}
