import { describe, expect, it } from "vitest";
import { finalizeRepricerPriceSemantics, type WalletParserResult } from "./wbWalletPriceParser.js";

function baseResult(overrides: Partial<WalletParserResult>): WalletParserResult {
  return {
    nmId: 396186475,
    url: "https://www.wildberries.ru/catalog/396186475/detail.aspx",
    region: null,
    priceRegular: 1500,
    buyerVisiblePriceRub: 1176,
    priceWallet: 1176,
    showcaseRub: 1200,
    walletRub: 1176,
    nonWalletRub: null,
    walletConfirmed: true,
    walletEvidence: "dom_wallet",
    walletEvidenceLayers: ["dom_wallet"],
    walletLabel: "с WB Кошельком",
    walletDiscountText: null,
    inStock: true,
    parsedAt: new Date().toISOString(),
    source: "dom",
    parseStatus: "loaded_wallet_confirmed",
    sourceConfidence: 0.9,
    parseMethod: "dom",
    showcaseRubEffective: 1200,
    showcaseApiRub: 1200,
    cardApiShowcaseRub: 1200,
    showcaseRubFromDom: 1200,
    walletPriceRubAcceptedFromDom: 1176,
    walletIconDetected: true,
    buyerPriceVerification: {
      verificationStatus: "VERIFIED",
      verificationReason: "dom_wallet_detected",
      sellerBasePriceRub: null,
      showcaseWalletPrice: 1176,
      walletPriceVerified: 1176,
      priceWithoutWallet: null,
      walletDiscountRub: null,
      walletDiscount: null,
      walletIconDetected: true,
      sourceSeller: "none",
      sourceWalletVisible: "dom_price_block",
      sourceWalletDetails: "product_page_wallet_selector",
      sourceWithoutWallet: "none",
      verificationMethod: "dom_wallet",
      repricingAllowed: true,
      trustedSource: "product_page_wallet_selector",
      cardApiShowcaseRub: 1200,
      cardApiWalletRub: null,
    },
    ...overrides,
  } as WalletParserResult;
}

describe("wbWalletPriceParser wallet/showcase/nonWallet semantics", () => {
  it("keeps wallet/showcase from walletPriceRubAcceptedFromDom and nonWallet from showcaseRubFromDom", () => {
    const out = finalizeRepricerPriceSemantics(baseResult({}), null);
    expect(out.walletRub).toBe(1176);
    expect(out.showcaseRub).toBe(1176);
    expect(out.nonWalletRub).toBe(1200);
    expect(out.priceRegular).toBe(1500);
  });

  it("does not take cardApi showcase as nonWallet when it equals wallet", () => {
    const out = finalizeRepricerPriceSemantics(
      baseResult({
        showcaseRubFromDom: null,
        nonWalletRub: null,
        cardApiShowcaseRub: 1176,
        showcaseApiRub: 1176,
      }),
      null,
    );
    expect(out.walletRub).toBe(1176);
    expect(out.showcaseRub).toBe(1176);
    expect(out.nonWalletRub).toBeNull();
  });
});
