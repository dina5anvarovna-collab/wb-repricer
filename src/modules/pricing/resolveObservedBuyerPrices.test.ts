import { describe, expect, it } from "vitest";
import { computeBuyerPriceVerification } from "./buyerPriceVerification.js";
import { resolveObservedBuyerPrices } from "./resolveObservedBuyerPrices.js";
import type { BuyerDomResult } from "../wbBuyerDom/runWalletCli.js";

const DEST = "-1257786";

function fallbackCtx(over?: Partial<Parameters<typeof resolveObservedBuyerPrices>[0]["fallbackContext"]>) {
  return {
    discountedPriceRub: 1000,
    targetRub: null,
    sellerPrice: 1200,
    lastSnapshotWalletRub: null,
    lastSnapshotRegularRub: null,
    lastKnownShowcaseRub: null,
    lastKnownWalletRub: null,
    lastRegularObservedRub: null,
    lastWalletObservedRub: null,
    ...over,
  };
}

function strongVerifiedDom(): BuyerDomResult {
  const buyerPriceVerification = computeBuyerPriceVerification({
    sellerBasePriceRub: 1200,
    showcaseWalletPriceCandidate: 900,
    walletIconDetected: true,
    cardApiShowcaseRub: null,
    cardApiWalletRub: null,
  });
  return {
    nmId: 111,
    url: `https://www.wildberries.ru/catalog/111/detail.aspx?dest=${DEST}`,
    buyerVisiblePriceRub: 900,
    priceWallet: 900,
    walletLabel: "₽",
    walletDiscountText: "",
    parsedAt: new Date().toISOString(),
    source: "dom",
    success: true,
    buyerPriceVerification,
    parseStatus: "loaded_wallet_confirmed",
    showcaseRubFromCookies: 950,
    browserUrlAfterParse: `https://www.wildberries.ru/catalog/111/detail.aspx?dest=${DEST}`,
    walletConfirmed: true,
    walletRub: 900,
    showcaseRubFromDom: 900,
    regionPriceAmbiguous: false,
    destApplied: true,
    regionConfirmed: true,
    regionConfirmedByStableReload: true,
    regionDomConfirmed: true,
    regionConfirmedByRequest: true,
    priceRegular: null,
    inStock: true,
    sourceConflictDetected: false,
  } as BuyerDomResult;
}

describe("resolveObservedBuyerPrices buyer truth pipeline", () => {
  it("strong verified wallet: persists verified snapshot fields when cross-check passes", () => {
    const r = resolveObservedBuyerPrices({
      dom: strongVerifiedDom(),
      stockLevel: "IN_STOCK",
      expectedNmId: 111,
      expectedDest: DEST,
      monitorBatchDestCount: 1,
      fallbackContext: fallbackCtx(),
    });
    expect(r.buyerPriceVerification.verificationStatus).toBe("VERIFIED");
    expect(r.buyerWallet).not.toBeNull();
    expect(r.showcaseRub).toBe(r.buyerWallet);
    expect(r.repricingAllowed).toBe(true);
  });

  it("ambiguous region: suppresses wallet/showcase truth even when parser said VERIFIED", () => {
    const dom = strongVerifiedDom();
    dom.regionPriceAmbiguous = true;
    dom.regionConfirmedByStableReload = false;
    const r = resolveObservedBuyerPrices({
      dom,
      stockLevel: "IN_STOCK",
      expectedNmId: 111,
      expectedDest: DEST,
      monitorBatchDestCount: 1,
      fallbackContext: fallbackCtx(),
    });
    expect(r.buyerPriceVerification.verificationStatus).toBe("UNVERIFIED");
    expect(r.buyerWallet).toBeNull();
    expect(r.showcaseRub).toBeNull();
    expect(r.repricingAllowed).toBe(false);
  });

  it("blocked_or_captcha: never exposes DOM wallet as buyer truth", () => {
    const dom = strongVerifiedDom();
    dom.parseStatus = "blocked_or_captcha";
    const r = resolveObservedBuyerPrices({
      dom,
      stockLevel: "IN_STOCK",
      expectedNmId: 111,
      expectedDest: DEST,
      monitorBatchDestCount: 1,
      fallbackContext: fallbackCtx(),
    });
    expect(r.buyerPriceVerification.verificationStatus).toBe("UNVERIFIED");
    expect(r.buyerWallet).toBeNull();
    expect(r.showcaseRub).toBeNull();
    expect(r.repricingAllowed).toBe(false);
  });

  it("non-wallet-only path: leaves wallet null when verification is UNVERIFIED", () => {
    const buyerPriceVerification = computeBuyerPriceVerification({
      sellerBasePriceRub: 1200,
      showcaseWalletPriceCandidate: null,
      walletIconDetected: false,
    });
    const dom = {
      ...strongVerifiedDom(),
      buyerPriceVerification,
      parseStatus: "loaded_no_price",
      walletConfirmed: false,
      walletRub: null,
      showcaseRubFromDom: null,
    } as BuyerDomResult;
    const r = resolveObservedBuyerPrices({
      dom,
      stockLevel: "IN_STOCK",
      expectedNmId: 111,
      expectedDest: DEST,
      monitorBatchDestCount: 1,
      fallbackContext: fallbackCtx(),
    });
    expect(r.buyerPriceVerification.verificationStatus).toBe("UNVERIFIED");
    expect(r.buyerWallet).toBeNull();
    expect(r.repricingAllowed).toBe(false);
  });

  it("legacy API shape: buyerPriceVerification.repricingAllowed aligns with resolved.repricingAllowed", () => {
    const r = resolveObservedBuyerPrices({
      dom: strongVerifiedDom(),
      stockLevel: "IN_STOCK",
      expectedNmId: 111,
      expectedDest: DEST,
      monitorBatchDestCount: 1,
      fallbackContext: fallbackCtx(),
    });
    expect(r.buyerPriceVerification.repricingAllowed).toBe(r.repricingAllowed);
  });

  it("multi-dest monitor run defers VERIFIED until catalog batch (marks UNVERIFIED per step)", () => {
    const r = resolveObservedBuyerPrices({
      dom: strongVerifiedDom(),
      stockLevel: "IN_STOCK",
      expectedNmId: 111,
      expectedDest: DEST,
      monitorBatchDestCount: 3,
      fallbackContext: fallbackCtx(),
    });
    expect(r.buyerPriceVerification.verificationStatus).toBe("UNVERIFIED");
    expect(r.repricingAllowed).toBe(false);
  });
});
