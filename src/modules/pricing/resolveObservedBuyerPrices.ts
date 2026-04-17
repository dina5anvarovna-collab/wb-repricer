import type { StockLevel } from "../../lib/stockLevel.js";
import type { BuyerDomResult } from "../wbBuyerDom/runWalletCli.js";
import { env } from "../../config/env.js";
import type { MonitorFallbackPrices } from "../priceMonitor/monitorPriceFallback.js";
import type { BuyerPriceVerificationSnapshot } from "./buyerPriceVerification.js";

type FallbackContext = {
  discountedPriceRub: number | null;
  targetRub: number | null;
  sellerPrice: number | null;
  lastSnapshotWalletRub: number | null;
  lastSnapshotRegularRub: number | null;
  lastKnownShowcaseRub: number | null;
  lastKnownWalletRub: number | null;
  lastRegularObservedRub: number | null;
  lastWalletObservedRub: number | null;
};

export type ResolvedObservedBuyerPrices = {
  basePriceRub: number | null;
  sellerDiscountPriceRub: number | null;
  sppRub: number | null;
  walletPriceRub: number | null;
  showcasePriceRub: number | null;
  priceWithSppWithoutWalletRub: number | null;
  showcaseRub: number | null;
  priceWithoutWalletRub: number | null;
  walletDiscountRub: number | null;
  walletDiscountPercent: number | null;
  oldPriceRub: number | null;
  sppPercent: number | null;
  finalVisibleRub: number | null;
  sourceConfidence: "high" | "medium" | "low";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  priceParseMode: "dom_wallet_only" | "fallback" | "unverified";
  topPriceFound: boolean;
  buyerWallet: number | null;
  buyerRegular: number | null;
  walletSource: string;
  buyerRegularSource: string;
  hasUsablePrice: boolean;
  fallback: MonitorFallbackPrices;
  repricingAllowed: boolean;
  repricingAllowedReason: string;
  blockedBySafetyRule: string[];
  verificationSource: "dom_buybox" | "product_page_wallet_selector" | "card_api" | "none" | "unverified";
  trustedSource: "product_page_wallet_selector" | "none";
  sourcePriority: string | null;
  sourceConflictDetected: boolean;
  buyerPriceVerification: BuyerPriceVerificationSnapshot;
  sppCalcSource: "cookies" | "popup" | "none";
  sppCalcReason:
    | "ok"
    | "spp_missing_seller_discount"
    | "spp_missing_cookie_showcase"
    | "spp_invalid_range";
  destApplied: boolean | null;
  regionDomConfirmed: boolean | null;
  regionConfirmedByRequest: boolean | null;
  regionConfirmedByStableReload: boolean | null;
  regionConfirmed: boolean | null;
  destAppliedButNotConfirmed: boolean | null;
  regionPriceAmbiguous: boolean | null;
  walletPriceFirstRead: number | null;
  walletPriceSecondRead: number | null;
  finalRegionConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
  finalWalletConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
  repricingDecisionSource: string | null;
  signals: {
    showcaseEff: number | null;
    cookieShowcase: number | null;
    apiWalletRub: number | null;
    domRegular: number | null;
    sppWoWallet: number | null;
  };
};

function toRub(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
}

function percent(numerator: number | null, denominator: number | null): number | null {
  if (
    numerator == null ||
    denominator == null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  const pct = (numerator / denominator) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isFinite(rounded) ? rounded : null;
}

function finalizeVerificationFromDom(
  dom: BuyerDomResult,
  sellerPrice: number | null,
): BuyerPriceVerificationSnapshot {
  const raw = dom.buyerPriceVerification;
  const sellerBasePriceRub = toRub(sellerPrice);
  if (!raw) {
    return {
      verificationStatus: "UNVERIFIED",
      verificationReason: "parser_missing_buyerPriceVerification",
      sellerBasePriceRub,
      /** Не подставляем DOM regular/showcase — без парсера верификации это не buyer-facing truth. */
      showcaseWalletPrice: null,
      walletPriceVerified: null,
      priceWithoutWallet: null,
      walletDiscountRub: null,
      walletDiscount: null,
      walletIconDetected: false,
      sourceSeller: sellerBasePriceRub != null ? "wb_seller_api" : "none",
      sourceWalletVisible: "none",
      sourceWalletDetails: "none",
      sourceWithoutWallet: "none",
      verificationMethod: "unverified",
      repricingAllowed: false,
      trustedSource: "none",
      cardApiShowcaseRub: toRub(dom.showcaseRubEffective ?? dom.showcaseApiRub),
      cardApiWalletRub: toRub(dom.apiWalletRub),
    };
  }
  return {
    ...raw,
    sellerBasePriceRub: raw.sellerBasePriceRub ?? sellerBasePriceRub,
    sourceSeller: sellerBasePriceRub != null ? "wb_seller_api" : "none",
  };
}

/**
 * Итоговая модель цен:
 * - walletPriceRub берём из DOM витрины.
 * - sppRub берём из buyer session/cookies.
 * - priceWithoutWalletRub считаем формулой sellerDiscountPriceRub - sppRub.
 */
export function resolveObservedBuyerPrices(input: {
  dom: BuyerDomResult;
  stockLevel: StockLevel;
  expectedNmId?: number | null;
  expectedDest?: string | null;
  fallbackContext: FallbackContext;
}): ResolvedObservedBuyerPrices {
  const { dom, stockLevel, fallbackContext } = input;
  const verification = finalizeVerificationFromDom(dom, fallbackContext.sellerPrice);

  const showcaseEff = toRub(dom.showcaseRubEffective);
  const showcasePriceRub = toRub(dom.showcasePriceRub);
  const cookieShowcase = toRub(dom.showcaseRubFromCookies);
  const popupWithoutWalletRub = toRub(dom.popupWithoutWalletRub);
  const popupWalletRub = toRub(dom.popupWalletRub);
  const popupParsed =
    dom.popupOpened === true &&
    popupWithoutWalletRub != null &&
    popupWithoutWalletRub > 0 &&
    popupWalletRub != null &&
    popupWalletRub > 0;
  const apiWalletRub = toRub(dom.apiWalletRub);
  const domRegular = toRub(dom.priceRegular);
  const domWalletObserved = toRub(
    popupWalletRub ??
      (dom as BuyerDomResult & { walletPriceRubAcceptedFromDom?: number | null }).walletPriceRubAcceptedFromDom ??
      dom.showcaseRubFromDom ??
      dom.priceWallet,
  );
  const oldPriceRub = toRub((dom as any).oldPriceRub ?? null);
  const basePriceRub = toRub(fallbackContext.sellerPrice);
  const sellerDiscountPriceRub = toRub(fallbackContext.discountedPriceRub);

  /**
   * Критично: business wallet/showcase берём ТОЛЬКО из validated DOM wallet selector.
   * Никакие card_api/domRegular сигналы не должны писать значение в wallet/showcase поля.
   */
  const domWalletVerifiedRub = toRub(
    verification.verificationMethod === "dom_wallet"
      ? (popupWalletRub ?? verification.walletPriceVerified ?? verification.showcaseWalletPrice)
      : null,
  );
  /**
   * Важно: даже при region_not_confirmed сохраняем наблюдаемую DOM-цену кошелька,
   * чтобы не терять фактическую витрину в таблице. Но для репрайса используется
   * только verified dom_wallet + подтверждённый регион (см. repricingAllowed ниже).
   */
  let buyerWallet: number | null = domWalletVerifiedRub ?? domWalletObserved;
  let walletSource =
    domWalletVerifiedRub != null
      ? "product_page_wallet_selector"
      : domWalletObserved != null
        ? "product_page_wallet_selector_unconfirmed"
        : "unavailable";
  let parseMode: ResolvedObservedBuyerPrices["priceParseMode"] =
    domWalletVerifiedRub != null
      ? "dom_wallet_only"
      : domWalletObserved != null
        ? "fallback"
        : "unverified";
  const topPriceFound = buyerWallet != null;

  /**
   * Новая модель:
   * - sppRub берём из buyer session/cookies (showcaseRubFromCookies) как отдельный сигнал.
   * - priceWithoutWalletRub считаем только формулой:
   *   sellerDiscountPriceRub - sppRub.
   */
  let sppRub: number | null = null;
  let sppCalcSource: ResolvedObservedBuyerPrices["sppCalcSource"] = "none";
  let sppCalcReason: ResolvedObservedBuyerPrices["sppCalcReason"] = "ok";
  if (sellerDiscountPriceRub == null || sellerDiscountPriceRub <= 0) {
    sppCalcReason = "spp_missing_seller_discount";
  } else {
    const regularForSpp =
      cookieShowcase != null && cookieShowcase > 0
        ? cookieShowcase
        : popupParsed && popupWithoutWalletRub != null
          ? popupWithoutWalletRub
          : null;
    sppCalcSource =
      cookieShowcase != null && cookieShowcase > 0
        ? "cookies"
        : popupParsed && popupWithoutWalletRub != null
          ? "popup"
          : "none";
    if (regularForSpp == null) {
      sppCalcReason = "spp_missing_cookie_showcase";
    } else {
      const raw = Math.round(sellerDiscountPriceRub - regularForSpp);
      if (raw >= 0 && raw < sellerDiscountPriceRub) {
        sppRub = raw;
        sppCalcReason = "ok";
      } else {
        sppCalcReason = "spp_invalid_range";
      }
    }
  }
  let buyerRegular: number | null =
    sellerDiscountPriceRub != null && sppRub != null
      ? Math.max(0, Math.round(sellerDiscountPriceRub - sppRub))
      : null;
  const fallback: MonitorFallbackPrices = {
    buyerRegular,
    buyerWallet,
    walletSource,
    lastPriceSource: "dom",
    usedFallback: false,
    fallbackChain: [],
  };

  /** Колонки снимка: wallet только из DOM wallet selector, СПП только формула. */
  let showcaseRub = buyerWallet;
  let priceWithoutWalletRub = buyerRegular;
  let walletDiscountRub =
    showcaseRub != null && priceWithoutWalletRub != null
      ? Math.max(0, Math.round(priceWithoutWalletRub - showcaseRub))
      : null;
  let walletDiscountPercent = percent(walletDiscountRub, priceWithoutWalletRub);
  let sppPercent = percent(sppRub, sellerDiscountPriceRub);

  let sourceConfidence: "high" | "medium" | "low" =
    verification.verificationMethod === "dom_wallet" ? "high" : verification.verificationStatus === "VERIFIED" ? "high" : "low";

  const buyerRegularSource = "formula_seller_discount_minus_spp";

  const hasUsablePrice =
    (buyerWallet != null && Number.isFinite(buyerWallet) && buyerWallet > 0) ||
    (buyerRegular != null && Number.isFinite(buyerRegular) && buyerRegular > 0);

  const blockedBySafetyRule: string[] = [];
  let invalid = false;
  let walletInvalid = false;
  let regularInvalid = false;
  const expectedNmId = input.expectedNmId ?? null;
  const expectedDest = input.expectedDest?.trim() || null;
  const actualNmId = dom.nmId ?? null;
  if (expectedNmId != null && actualNmId != null && expectedNmId !== actualNmId) {
    blockedBySafetyRule.push("nmid_mismatch");
  }
  const browserDest = (() => {
    if (!dom.browserUrlAfterParse) return null;
    try {
      return new URL(dom.browserUrlAfterParse).searchParams.get("dest")?.trim() || null;
    } catch {
      return null;
    }
  })();
  if (expectedDest != null && browserDest != null && expectedDest !== browserDest) {
    blockedBySafetyRule.push("dest_mismatch");
  }
  // destApplied и regionConfirmed — отдельные сущности:
  // - destApplied: URL/nmId совпали с ожиданиями
  // - regionConfirmed: есть хотя бы один реальный сигнал применения региона
  const regionDomConfirmed = dom.regionDomConfirmed === true;
  const regionConfirmedByRequest = dom.regionConfirmedByRequest === true || dom.destApplied === true;
  const regionConfirmedByStableReload = dom.regionConfirmedByStableReload === true;
  const regionConfirmedComposite =
    regionDomConfirmed || regionConfirmedByRequest || regionConfirmedByStableReload || dom.regionConfirmed === true;
  if (expectedDest != null) {
    if (dom.destApplied === false) {
      blockedBySafetyRule.push("dest_not_applied");
    }
    if (!regionConfirmedComposite || dom.destAppliedButNotConfirmed === true) {
      blockedBySafetyRule.push("region_not_confirmed");
    }
    if (dom.regionPriceAmbiguous === true && !regionConfirmedByStableReload) {
      blockedBySafetyRule.push("region_price_ambiguous");
    }
  }

  if (sellerDiscountPriceRub != null && sppRub != null && (sppRub < 0 || sppRub >= sellerDiscountPriceRub)) {
    blockedBySafetyRule.push("invalid_spp_range");
    regularInvalid = true;
    invalid = true;
  } else if (sellerDiscountPriceRub != null && sppRub == null) {
    blockedBySafetyRule.push(
      sppCalcReason === "spp_missing_cookie_showcase"
        ? "spp_missing_cookie_showcase"
        : sppCalcReason === "spp_invalid_range"
          ? "spp_invalid_range"
          : "spp_missing",
    );
  }
  if (buyerWallet == null || buyerWallet <= 0) {
    blockedBySafetyRule.push("invalid_wallet_price");
    walletInvalid = true;
    invalid = true;
  }
  if (
    buyerRegular != null &&
    buyerWallet != null &&
    buyerRegular < buyerWallet
  ) {
    blockedBySafetyRule.push("invalid_price_with_spp_lt_wallet");
    regularInvalid = true;
    invalid = true;
  }
  if (walletInvalid) {
    buyerWallet = null;
  }
  if (regularInvalid) {
    buyerRegular = null;
  }
  if (invalid) {
    showcaseRub = buyerWallet;
    priceWithoutWalletRub = buyerRegular;
    walletDiscountRub =
      showcaseRub != null && priceWithoutWalletRub != null
        ? Math.max(0, Math.round(priceWithoutWalletRub - showcaseRub))
        : null;
    walletDiscountPercent = percent(walletDiscountRub, priceWithoutWalletRub);
    sppPercent = percent(sppRub, sellerDiscountPriceRub);
  }
  if (walletInvalid && regularInvalid) {
    buyerWallet = null;
    buyerRegular = null;
    showcaseRub = null;
    priceWithoutWalletRub = null;
    walletDiscountRub = null;
    walletDiscountPercent = null;
  }

  if (showcaseRub != null && fallbackContext.sellerPrice != null && fallbackContext.sellerPrice > 0) {
    const ratio = showcaseRub / fallbackContext.sellerPrice;
    if (ratio < env.REPRICER_SHOWCASE_MIN_RATIO_TO_SELLER || ratio > env.REPRICER_SHOWCASE_MAX_RATIO_TO_SELLER) {
      blockedBySafetyRule.push("showcase_vs_seller_anomaly");
    }
  }
  if (
    showcaseRub != null &&
    fallbackContext.lastKnownShowcaseRub != null &&
    fallbackContext.lastKnownShowcaseRub > 0
  ) {
    const jumpPct = Math.abs((showcaseRub - fallbackContext.lastKnownShowcaseRub) / fallbackContext.lastKnownShowcaseRub) * 100;
    if (jumpPct > env.REPRICER_SHOWCASE_MAX_JUMP_PCT) {
      blockedBySafetyRule.push("showcase_jump_anomaly");
    }
  }

  const confidence: "HIGH" | "MEDIUM" | "LOW" =
    verification.verificationMethod === "dom_wallet" && showcaseRub != null && showcaseRub > 0
      ? "HIGH"
      : showcaseRub != null &&
          priceWithoutWalletRub != null &&
          !invalid &&
          blockedBySafetyRule.length === 0
        ? "HIGH"
        : showcaseRub != null && !invalid && blockedBySafetyRule.length <= 1
          ? "MEDIUM"
          : "LOW";
  sourceConfidence = confidence === "HIGH" ? "high" : confidence === "MEDIUM" ? "medium" : "low";
  const strongWalletSignal =
    verification.verificationStatus === "VERIFIED" &&
    verification.verificationMethod === "dom_wallet" &&
    verification.trustedSource === "product_page_wallet_selector" &&
    dom.parseStatus === "wallet_found" &&
    topPriceFound === true &&
    showcaseRub != null &&
    showcaseRub > 0;
  const repricingAllowed =
    strongWalletSignal &&
    (expectedDest == null ? true : regionConfirmedComposite) &&
    !(dom.regionPriceAmbiguous === true && !regionConfirmedByStableReload);
  const repricingAllowedReason = repricingAllowed
    ? "strong_wallet_plus_region_confirmation"
    : [verification.verificationReason, ...blockedBySafetyRule].filter(Boolean).join(";");

  return {
    basePriceRub,
    sellerDiscountPriceRub,
    sppRub,
    walletPriceRub: showcaseRub,
    showcasePriceRub: showcaseRub,
    priceWithSppWithoutWalletRub: priceWithoutWalletRub,
    showcaseRub,
    priceWithoutWalletRub,
    walletDiscountRub,
    walletDiscountPercent,
    oldPriceRub,
    sppPercent,
    finalVisibleRub: showcaseRub,
    sourceConfidence,
    confidence,
    priceParseMode: parseMode,
    topPriceFound,
    buyerWallet,
    buyerRegular,
    walletSource,
    buyerRegularSource,
    hasUsablePrice,
    fallback,
    repricingAllowed,
    repricingAllowedReason,
    blockedBySafetyRule,
    verificationSource:
      dom.verificationSource ??
      (verification.verificationMethod === "dom_wallet"
        ? "product_page_wallet_selector"
        : "unverified"),
    trustedSource: verification.trustedSource,
    sourcePriority: typeof dom.sourcePriority === "string" ? dom.sourcePriority : null,
    sourceConflictDetected: dom.sourceConflictDetected === true,
    buyerPriceVerification: verification,
    sppCalcSource,
    sppCalcReason,
    destApplied: typeof dom.destApplied === "boolean" ? dom.destApplied : null,
    regionDomConfirmed: typeof dom.regionDomConfirmed === "boolean" ? dom.regionDomConfirmed : null,
    regionConfirmedByRequest:
      typeof dom.regionConfirmedByRequest === "boolean" ? dom.regionConfirmedByRequest : null,
    regionConfirmedByStableReload:
      typeof dom.regionConfirmedByStableReload === "boolean" ? dom.regionConfirmedByStableReload : null,
    regionConfirmed: typeof dom.regionConfirmed === "boolean" ? dom.regionConfirmed : null,
    destAppliedButNotConfirmed:
      typeof dom.destAppliedButNotConfirmed === "boolean" ? dom.destAppliedButNotConfirmed : null,
    regionPriceAmbiguous:
      typeof dom.regionPriceAmbiguous === "boolean" ? dom.regionPriceAmbiguous : null,
    walletPriceFirstRead:
      typeof dom.walletPriceFirstRead === "number" ? Math.round(dom.walletPriceFirstRead) : null,
    walletPriceSecondRead:
      typeof dom.walletPriceSecondRead === "number" ? Math.round(dom.walletPriceSecondRead) : null,
    finalRegionConfidence:
      dom.finalRegionConfidence === "HIGH" ||
      dom.finalRegionConfidence === "MEDIUM" ||
      dom.finalRegionConfidence === "LOW"
        ? dom.finalRegionConfidence
        : null,
    finalWalletConfidence:
      dom.finalWalletConfidence === "HIGH" ||
      dom.finalWalletConfidence === "MEDIUM" ||
      dom.finalWalletConfidence === "LOW"
        ? dom.finalWalletConfidence
        : null,
    repricingDecisionSource:
      typeof dom.repricingDecisionSource === "string" ? dom.repricingDecisionSource : null,
    signals: {
      showcaseEff: showcasePriceRub,
      cookieShowcase,
      apiWalletRub,
      domRegular,
      sppWoWallet: popupWithoutWalletRub,
    },
  };
}
