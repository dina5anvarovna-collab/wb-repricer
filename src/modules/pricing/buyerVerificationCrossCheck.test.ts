import { describe, expect, it } from "vitest";
import { applyBuyerVerificationCrossCheck, canPersistVerifiedWalletTruth } from "./buyerVerificationCrossCheck.js";
import type { BuyerPriceVerificationSnapshot } from "./buyerPriceVerification.js";

function verifiedSnapshot(): BuyerPriceVerificationSnapshot {
  return {
    verificationStatus: "VERIFIED",
    verificationReason: "dom_wallet_detected",
    sellerBasePriceRub: 3000,
    showcaseWalletPrice: 1500,
    walletPriceVerified: 1500,
    priceWithoutWallet: null,
    walletDiscountRub: null,
    walletDiscount: null,
    walletIconDetected: true,
    sourceSeller: "wb_seller_api",
    sourceWalletVisible: "dom_price_block",
    sourceWalletDetails: "product_page_wallet_selector",
    sourceWithoutWallet: "formula",
    verificationMethod: "dom_wallet",
    repricingAllowed: true,
    trustedSource: "product_page_wallet_selector",
    cardApiShowcaseRub: null,
    cardApiWalletRub: null,
  };
}

describe("buyerVerificationCrossCheck", () => {
  it("downgrades when safety blocker present", () => {
    const out = applyBuyerVerificationCrossCheck(
      { parseStatus: "loaded_wallet_confirmed", regionPriceAmbiguous: false, sourceConflictDetected: false },
      verifiedSnapshot(),
      ["region_price_ambiguous"],
    );
    expect(out.verificationStatus).toBe("UNVERIFIED");
  });

  it("canPersistVerifiedWalletTruth rejects ambiguity", () => {
    expect(
      canPersistVerifiedWalletTruth({
        verification: verifiedSnapshot(),
        blockedBySafetyRule: [],
        regionPriceAmbiguous: true,
        parseStatus: "loaded_wallet_confirmed",
      }),
    ).toBe(false);
  });
});
