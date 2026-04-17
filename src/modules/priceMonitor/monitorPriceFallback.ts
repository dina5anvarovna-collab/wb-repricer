import type { StockLevel } from "../../lib/stockLevel.js";

export type MonitorFallbackPrices = {
  buyerRegular: number | null;
  buyerWallet: number | null;
  walletSource: string;
  lastPriceSource: string;
  usedFallback: boolean;
  fallbackChain: string[];
};

type ProductLike = {
  discountedPriceRub: number | null;
  targetRub: number | null;
  sellerPrice: number | null;
  /** Кэш «витринной» цифры (card/API/DOM) — не путать с «цена с СПП без кошелька» */
  lastKnownShowcaseRub: number | null;
  /** Последний явно распознанный WB Кошелёк из DOM (без подстановки витрины) */
  lastKnownWalletRub: number | null;
  /** Последняя сохранённая «цена с СПП» (без кошелька) с прошлого мониторинга */
  lastRegularObservedRub: number | null;
  /** Последний сохранённый итог кошелька (в т.ч. после подстановки витрины) */
  lastWalletObservedRub: number | null;
};

/**
 * Цены для снимка при отсутствии витрины **только для OUT_OF_STOCK** (защита минимума без живой карточки).
 *
 * `buyerRegular` = цена **с СПП без WB Кошелька** (не итог витрины).
 * `buyerWallet` = **WB Кошелёк** или последний сохранённый итог покупателя.
 *
 * Порядок для regular: прошлый lastRegularObservedRub → кэши → кабинет → target.
 * Порядок для wallet: прошлый lastWalletObservedRub → lastKnownWalletRub (только DOM-кошелёк).
 */
export function applyMonitorPriceFallback(
  p: ProductLike,
  stockLevel: StockLevel,
  prelimRegular: number | null,
  prelimWallet: number | null,
): MonitorFallbackPrices {
  const chain: string[] = [];
  let buyerRegular = prelimRegular;
  let buyerWallet = prelimWallet;
  let walletSource = "dom";
  let lastPriceSource = "dom";

  if (stockLevel !== "OUT_OF_STOCK") {
    return {
      buyerRegular,
      buyerWallet,
      walletSource,
      lastPriceSource,
      usedFallback: false,
      fallbackChain: [],
    };
  }

  const needRegular = buyerRegular == null;
  const needWallet = buyerWallet == null;

  if (!needRegular && !needWallet) {
    return {
      buyerRegular,
      buyerWallet,
      walletSource,
      lastPriceSource,
      usedFallback: false,
      fallbackChain: [],
    };
  }

  if (needRegular) {
    if (
      p.lastRegularObservedRub != null &&
      Number.isFinite(p.lastRegularObservedRub) &&
      p.lastRegularObservedRub > 0
    ) {
      buyerRegular = Math.round(p.lastRegularObservedRub);
      chain.push("lastRegularObservedRub");
    } else if (p.lastKnownShowcaseRub != null && Number.isFinite(p.lastKnownShowcaseRub)) {
      buyerRegular = p.lastKnownShowcaseRub;
      chain.push("lastKnownShowcaseRub");
    } else if (p.lastKnownWalletRub != null && Number.isFinite(p.lastKnownWalletRub)) {
      buyerRegular = p.lastKnownWalletRub;
      chain.push("lastKnownWalletRub_as_regular_fallback");
    } else if (p.discountedPriceRub != null && Number.isFinite(p.discountedPriceRub)) {
      buyerRegular = p.discountedPriceRub;
      chain.push("discountedPriceRub");
    } else if (p.sellerPrice != null && Number.isFinite(p.sellerPrice)) {
      buyerRegular = p.sellerPrice;
      chain.push("sellerPrice");
    } else if (p.targetRub != null && Number.isFinite(p.targetRub)) {
      buyerRegular = p.targetRub;
      chain.push("targetRub_floor");
    }
  }

  if (needWallet) {
    if (
      p.lastWalletObservedRub != null &&
      Number.isFinite(p.lastWalletObservedRub) &&
      p.lastWalletObservedRub > 0
    ) {
      buyerWallet = Math.round(p.lastWalletObservedRub);
      chain.push("lastWalletObservedRub");
    } else if (p.lastKnownWalletRub != null && Number.isFinite(p.lastKnownWalletRub)) {
      buyerWallet = p.lastKnownWalletRub;
      chain.push("lastKnownWalletRub");
    }
    /** Не подменяем wallet ценой витрины/showcase в этом fallback — только сохранённые итоги. */
  }

  const usedFallback = chain.length > 0;
  if (usedFallback) {
    walletSource = "fallback_oos";
    const hasCabinet = chain.some((c) =>
      ["discountedPriceRub", "sellerPrice"].includes(c),
    );
    const hasCache = chain.some((c) => c.startsWith("lastKnown"));
    lastPriceSource =
      hasCache && hasCabinet ? "mixed" : hasCache ? "fallback_cache" : hasCabinet ? "fallback_cabinet" : "fallback_floor";
  }

  return {
    buyerRegular,
    buyerWallet,
    walletSource,
    lastPriceSource,
    usedFallback,
    fallbackChain: chain,
  };
}
