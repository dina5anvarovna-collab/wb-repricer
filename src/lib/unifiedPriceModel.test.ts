import { describe, expect, it } from "vitest";
import {
  buildBuyerSideFromPriceSnapshot,
  buildBuyerSideFromWbProductFallbackChain,
} from "./unifiedPriceModel.js";

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
