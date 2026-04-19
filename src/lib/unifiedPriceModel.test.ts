import { describe, expect, it } from "vitest";
import {
  buildBuyerSideFromPriceSnapshot,
  buildBuyerSideFromWbProductFallbackChain,
  sanitizeNonWalletRubAgainstSeller,
  sellerCabinetRegularRub,
  syncShowcaseRubWithWalletRub,
} from "./unifiedPriceModel.js";

describe("sellerCabinetRegularRub / sanitizeNonWalletRubAgainstSeller", () => {
  it("maps priceRegular from discounted seller price", () => {
    expect(sellerCabinetRegularRub({ sellerPrice: 2000, discountedPriceRub: 1500 })).toBe(1500);
  });

  it("drops nonWallet equal to seller cabinet discount price", () => {
    const seller = {
      sellerPriceRub: 2000,
      sellerDiscountPct: null,
      sellerDiscountPriceRub: 1500,
    };
    expect(sanitizeNonWalletRubAgainstSeller(1500, seller)).toBeNull();
    expect(sanitizeNonWalletRubAgainstSeller(1400, seller)).toBe(1400);
  });
});

describe("syncShowcaseRubWithWalletRub", () => {
  it("forces showcase === wallet", () => {
    const b = syncShowcaseRubWithWalletRub({
      showcaseRub: 999,
      walletRub: 500,
      nonWalletRub: null,
      priceRegular: null,
    });
    expect(b.showcaseRub).toBe(500);
    expect(b.walletRub).toBe(500);
  });
});

describe("buildBuyerSideFromPriceSnapshot", () => {
  it("joins walletRub with legacy buyerWalletPrice column", () => {
    const b = buildBuyerSideFromPriceSnapshot({
      showcaseRub: null,
      buyerWalletPrice: 381,
      walletRub: null,
      nonWalletRub: 393,
      buyerRegularPrice: null,
      priceRegular: 550,
    });
    expect(b.walletRub).toBe(381);
    expect(b.nonWalletRub).toBe(393);
    expect(b.priceRegular).toBe(550);
  });
});

describe("buildBuyerSideFromWbProductFallbackChain", () => {
  it("fills wallet from walletRubLastGood when lastKnownWalletRub absent", () => {
    const b = buildBuyerSideFromWbProductFallbackChain({
      lastKnownShowcaseRub: null,
      lastWalletObservedRub: 999,
      lastKnownWalletRub: null,
      lastRegularObservedRub: 393,
      lastPriceRegularObservedRub: 550,
      walletRubLastGood: 381,
      nonWalletRubLastGood: null,
    });
    expect(b.walletRub).toBe(381);
    expect(b.nonWalletRub).toBe(393);
    expect(b.priceRegular).toBe(550);
  });
});
