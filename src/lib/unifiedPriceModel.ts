import type { PriceSnapshot, WbProduct } from "@prisma/client";

/** Единые имена для Seller API / кабинета (не витрина покупателя). */
export type SellerSidePricesJson = {
  sellerPriceRub: number | null;
  sellerDiscountPct: number | null;
  sellerDiscountPriceRub: number | null;
};

/** Единые имена для buyer/DOM (витрина, кошелёк, без кошелька, зачёркнутая). */
export type BuyerSidePricesJson = {
  showcaseRub: number | null;
  walletRub: number | null;
  nonWalletRub: number | null;
  priceRegular: number | null;
};

/** Одновременно seller-side и buyer-side для API / snapshot / audit. */
export type UnifiedPriceObservationJson = {
  /** Подпись региона (справочник wb-regions.json), если известна. */
  region?: string | null;
  /** Warehouse `dest` как число (часто отрицательное, напр. -1257786). */
  dest?: number | null;
  seller: SellerSidePricesJson;
  buyer: BuyerSidePricesJson;
};

/** Плейсхолдер, если в ответе нет Seller API (например, только parse-probe). */
export const EMPTY_SELLER_SIDE: SellerSidePricesJson = {
  sellerPriceRub: null,
  sellerDiscountPct: null,
  sellerDiscountPriceRub: null,
};

export function toUnifiedRub(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
}

export function buildSellerSideFromWbProduct(
  p: Pick<WbProduct, "sellerPrice" | "sellerDiscount" | "discountedPriceRub">,
): SellerSidePricesJson {
  const d = p.sellerDiscount;
  const pct =
    d != null && Number.isFinite(d) && d >= 0 && d < 100 ? Math.round(d) : null;
  return {
    sellerPriceRub: toUnifiedRub(p.sellerPrice),
    sellerDiscountPct: pct,
    sellerDiscountPriceRub: toUnifiedRub(p.discountedPriceRub),
  };
}

export function buildBuyerSideFromPriceSnapshot(
  s: Pick<
    PriceSnapshot,
    | "showcaseRub"
    | "buyerWalletPrice"
    | "walletRub"
    | "nonWalletRub"
    | "buyerRegularPrice"
    | "priceRegular"
  >,
): BuyerSidePricesJson {
  return {
    showcaseRub: toUnifiedRub(s.showcaseRub ?? s.buyerWalletPrice),
    /** Семантика как в parse-probe: подтверждённый кошелёк или устаревшее имя колонки buyerWalletPrice. */
    walletRub: toUnifiedRub(s.walletRub ?? s.buyerWalletPrice),
    nonWalletRub: toUnifiedRub(s.nonWalletRub ?? s.buyerRegularPrice),
    priceRegular: toUnifiedRub(s.priceRegular),
  };
}

export function buildBuyerSideFromWbProductCache(
  p: Pick<
    WbProduct,
    | "lastKnownShowcaseRub"
    | "lastWalletObservedRub"
    | "lastKnownWalletRub"
    | "lastRegularObservedRub"
    | "lastPriceRegularObservedRub"
  >,
): BuyerSidePricesJson {
  return {
    showcaseRub: toUnifiedRub(p.lastKnownShowcaseRub ?? p.lastWalletObservedRub),
    walletRub: toUnifiedRub(p.lastKnownWalletRub),
    nonWalletRub: toUnifiedRub(p.lastRegularObservedRub),
    priceRegular: toUnifiedRub(p.lastPriceRegularObservedRub),
  };
}

/**
 * Единственная цепочка fallback для каталога, когда нет свежего PriceSnapshot по primary региону
 * или снимок пустой: кэш карточки → last good (safe mode) → последние legacy last* колонки.
 * Не использовать как primary source, если unified уже собран из снимка.
 */
export function buildBuyerSideFromWbProductFallbackChain(
  p: Pick<
    WbProduct,
    | "lastKnownShowcaseRub"
    | "lastWalletObservedRub"
    | "lastKnownWalletRub"
    | "lastRegularObservedRub"
    | "lastPriceRegularObservedRub"
    | "walletRubLastGood"
    | "nonWalletRubLastGood"
  >,
): BuyerSidePricesJson {
  const base = buildBuyerSideFromWbProductCache(p);
  return {
    showcaseRub: base.showcaseRub,
    walletRub:
      base.walletRub ??
      toUnifiedRub(p.walletRubLastGood) ??
      toUnifiedRub(p.lastWalletObservedRub),
    nonWalletRub: base.nonWalletRub ?? toUnifiedRub(p.nonWalletRubLastGood),
    priceRegular: base.priceRegular,
  };
}

export function destStringToNumber(s: string | null | undefined): number | null {
  if (s == null || !String(s).trim()) return null;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** Зачёркнутая «regular» в buyer-слое каталога — только из кабинета (seller API), не из DOM снимка. */
export function sellerCabinetRegularRub(p: Pick<WbProduct, "sellerPrice" | "discountedPriceRub">): number | null {
  return toUnifiedRub(p.discountedPriceRub ?? p.sellerPrice ?? null);
}

/** nonWalletRub не должен совпадать с ценой продавца из API (иначе это не buyer СПП). */
export function sanitizeNonWalletRubAgainstSeller(
  nonWalletRub: number | null | undefined,
  seller: SellerSidePricesJson,
): number | null {
  const nw = toUnifiedRub(nonWalletRub);
  if (nw == null) return null;
  const cab = seller.sellerDiscountPriceRub ?? seller.sellerPriceRub ?? null;
  if (cab != null && Math.abs(nw - Math.round(cab)) <= 1) return null;
  return nw;
}

/** Инвариант витрины: showcase = wallet (или оба null). */
export function syncShowcaseRubWithWalletRub(buyer: BuyerSidePricesJson): BuyerSidePricesJson {
  const w = buyer.walletRub;
  return {
    ...buyer,
    showcaseRub: w ?? null,
    walletRub: w ?? null,
  };
}

export function buildUnifiedObservation(
  seller: SellerSidePricesJson,
  buyer: BuyerSidePricesJson,
  meta?: { region?: string | null; dest?: number | null },
): UnifiedPriceObservationJson {
  const out: UnifiedPriceObservationJson = { seller, buyer };
  if (meta) {
    if (meta.region !== undefined) out.region = meta.region;
    if (meta.dest !== undefined) out.dest = meta.dest;
  }
  return out;
}

export function buildUnifiedFromProductAndSnapshot(
  p: WbProduct,
  snap: Pick<
    PriceSnapshot,
    | "showcaseRub"
    | "buyerWalletPrice"
    | "walletRub"
    | "nonWalletRub"
    | "buyerRegularPrice"
    | "priceRegular"
  > | null,
): UnifiedPriceObservationJson {
  const seller = buildSellerSideFromWbProduct(p);
  const buyer = snap != null ? buildBuyerSideFromPriceSnapshot(snap) : buildBuyerSideFromWbProductCache(p);
  return buildUnifiedObservation(seller, buyer);
}

/**
 * Нормализация полей парсера визитки (без Seller API — seller заполняется вызывающим кодом или null).
 */
export function buildBuyerSideFromWalletParserLike(r: {
  showcaseRub?: number | null;
  showcaseRubEffective?: number | null;
  showcasePriceRub?: number | null;
  walletRub?: number | null;
  priceWallet?: number | null;
  nonWalletRub?: number | null;
  priceWithSppWithoutWalletRub?: number | null;
  priceRegular?: number | null;
  oldPriceRub?: number | null;
}): BuyerSidePricesJson {
  const showcase =
    toUnifiedRub(r.showcaseRub) ??
    toUnifiedRub(r.showcaseRubEffective) ??
    toUnifiedRub(r.showcasePriceRub) ??
    toUnifiedRub(r.priceWallet);
  return {
    showcaseRub: showcase,
    walletRub: toUnifiedRub(r.walletRub ?? r.priceWallet),
    nonWalletRub: toUnifiedRub(r.nonWalletRub ?? r.priceWithSppWithoutWalletRub),
    priceRegular: toUnifiedRub(r.oldPriceRub) ?? toUnifiedRub(r.priceRegular),
  };
}
