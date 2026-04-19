export type BuyerPriceVerificationStatus = "VERIFIED" | "UNVERIFIED";

/**
 * Единая модель buyer-facing цен и верификации (не смешивать с sellerBasePrice).
 * sellerBasePrice — только WB Seller API; в снимок подставляется из WbProduct.sellerPrice.
 */
export type BuyerPriceVerificationSnapshot = {
  verificationStatus: BuyerPriceVerificationStatus;
  verificationReason: string;
  /** База продавца из кабинета (не buyer-facing). */
  sellerBasePriceRub: number | null;
  /** Видимая на карточке витринная цена с кошельком. */
  showcaseWalletPrice: number | null;
  /** Подтвержденная цена WB Кошелька из DOM wallet selector. */
  walletPriceVerified: number | null;
  /** Цена с СПП без кошелька (формула монитора или пара цен card.wb.ru). */
  priceWithoutWallet: number | null;
  walletDiscountRub: number | null;
  walletDiscount: number | null;
  walletIconDetected: boolean;
  sourceSeller: "wb_seller_api" | "none";
  sourceWalletVisible: "dom_price_block" | "none";
  sourceWalletDetails: "product_page_wallet_selector" | "none";
  sourceWithoutWallet: "formula" | "none" | "card_api_pair";
  verificationMethod: "dom_wallet" | "unverified";
  repricingAllowed: boolean;
  trustedSource: "product_page_wallet_selector" | "none";
  cardApiShowcaseRub: number | null;
  cardApiWalletRub: number | null;
};

const MATCH_TOL_RUB = 3;

export type ComputeBuyerPriceVerificationInput = {
  sellerBasePriceRub: number | null;
  showcaseWalletPriceCandidate: number | null;
  walletIconDetected: boolean;
  cardApiShowcaseRub?: number | null;
  cardApiWalletRub?: number | null;
};

/**
 * Если найден wallet-specific DOM selector + иконка кошелька,
 * это trusted source для WB Кошелька.
 */
export function computeBuyerPriceVerification(
  input: ComputeBuyerPriceVerificationInput,
): BuyerPriceVerificationSnapshot {
  const {
    sellerBasePriceRub,
    showcaseWalletPriceCandidate,
    walletIconDetected,
    cardApiShowcaseRub = null,
    cardApiWalletRub = null,
  } = input;

  const showcase = showcaseWalletPriceCandidate != null ? Math.round(showcaseWalletPriceCandidate) : null;

  const parts: string[] = [];
  if (!walletIconDetected) parts.push("no_wallet_icon");
  if (showcase == null) parts.push("no_showcase_candidate");

  const domWalletVerified = walletIconDetected && showcase != null && showcase > 0;
  const verified = domWalletVerified;

  const verificationStatus: BuyerPriceVerificationStatus = verified ? "VERIFIED" : "UNVERIFIED";
  const verificationReason = domWalletVerified ? "dom_wallet_detected" : parts.length ? parts.join(";") : "unknown";

  let priceWithoutWallet: number | null = null;
  let sourceWithoutWallet: BuyerPriceVerificationSnapshot["sourceWithoutWallet"] = "none";
  const cardCs = cardApiShowcaseRub != null && Number.isFinite(cardApiShowcaseRub) ? cardApiShowcaseRub : null;
  const cardW = cardApiWalletRub != null && Number.isFinite(cardApiWalletRub) ? cardApiWalletRub : null;
  if (
    cardCs != null &&
    cardW != null &&
    cardCs > cardW
  ) {
    priceWithoutWallet = Math.round(cardCs);
    sourceWithoutWallet = "card_api_pair";
  } else if (domWalletVerified) {
    sourceWithoutWallet = "formula";
  }

  return {
    verificationStatus,
    verificationReason,
    sellerBasePriceRub: sellerBasePriceRub != null && Number.isFinite(sellerBasePriceRub) ? Math.round(sellerBasePriceRub) : null,
    showcaseWalletPrice: showcase,
    walletPriceVerified: verified ? showcase : null,
    priceWithoutWallet,
    walletDiscountRub: null,
    walletDiscount: null,
    walletIconDetected,
    sourceSeller: sellerBasePriceRub != null && sellerBasePriceRub > 0 ? "wb_seller_api" : "none",
    sourceWalletVisible: showcase != null ? "dom_price_block" : "none",
    sourceWalletDetails: domWalletVerified ? "product_page_wallet_selector" : "none",
    sourceWithoutWallet,
    verificationMethod: domWalletVerified ? "dom_wallet" : "unverified",
    repricingAllowed: verified,
    trustedSource: domWalletVerified ? "product_page_wallet_selector" : "none",
    cardApiShowcaseRub: cardApiShowcaseRub != null ? Math.round(cardApiShowcaseRub) : null,
    cardApiWalletRub: cardApiWalletRub != null ? Math.round(cardApiWalletRub) : null,
  };
}
