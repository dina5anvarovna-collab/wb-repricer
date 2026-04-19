import type { PriceSnapshot } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { computeBatchBuyerTruth } from "./batchBuyerTruth.js";

function snap(
  wallet: number,
  detail: Record<string, unknown>,
  dest: string,
): PriceSnapshot {
  return {
    id: dest,
    productId: "p1",
    nmId: 1,
    sellerPrice: null,
    sellerDiscountPctSnapshot: null,
    priceRegular: null,
    showcaseRub: wallet,
    walletRub: wallet,
    nonWalletRub: null,
    buyerRegularPrice: null,
    buyerWalletPrice: wallet,
    walletConfirmed: true,
    walletEvidence: null,
    sellerDiscountedSnapshotRub: null,
    walletSource: "dom",
    fixedTargetPrice: null,
    diffSellerVsTarget: null,
    diffWalletVsTarget: null,
    regionDest: dest,
    regionLabel: null,
    syncJobId: "j",
    status: "ok",
    errorMessage: null,
    parseConfidence: 0.9,
    parseMethod: null,
    walletParseStatus: "loaded_wallet_confirmed",
    evaluationStatus: "ok",
    detailJson: JSON.stringify(detail),
    parsedAt: new Date(),
  } as unknown as PriceSnapshot;
}

describe("computeBatchBuyerTruth", () => {
  it("VERIFIED when single region, consistent wallet, no blockers", () => {
    const s = snap(500, { parseStatus: "loaded_wallet_confirmed", blockedBySafetyRule: [] }, "-1");
    const r = computeBatchBuyerTruth({ regionSnapshots: [s], monitorRegionCount: 1 });
    expect(r.batchVerificationStatus).toBe("VERIFIED");
    expect(r.effectiveWalletRub).toBe(500);
  });

  it("UNVERIFIED when same DOM wallet but card API showcase differs across dest", () => {
    const a = snap(
      500,
      {
        parseStatus: "loaded_wallet_confirmed",
        blockedBySafetyRule: [],
        buyerPriceVerification: { cardApiShowcaseRub: 700 },
        showcaseApiRub: 700,
      },
      "-1",
    );
    const b = snap(
      500,
      {
        parseStatus: "loaded_wallet_confirmed",
        blockedBySafetyRule: [],
        buyerPriceVerification: { cardApiShowcaseRub: 900 },
        showcaseApiRub: 900,
      },
      "-2",
    );
    const r = computeBatchBuyerTruth({ regionSnapshots: [a, b], monitorRegionCount: 2 });
    expect(r.batchVerificationStatus).toBe("UNVERIFIED");
    expect(r.batchVerificationReason).toContain("card_api_showcase_mismatch");
  });

  it("UNVERIFIED on weak parse", () => {
    const s = snap(500, { parseStatus: "blocked_or_captcha", blockedBySafetyRule: [] }, "-1");
    const r = computeBatchBuyerTruth({ regionSnapshots: [s], monitorRegionCount: 1 });
    expect(r.batchVerificationStatus).toBe("UNVERIFIED");
  });

  it("UNVERIFIED when wallet spreads across regions", () => {
    const a = snap(500, { parseStatus: "loaded_wallet_confirmed", blockedBySafetyRule: [] }, "-1");
    const b = snap(520, { parseStatus: "loaded_wallet_confirmed", blockedBySafetyRule: [] }, "-2");
    const r = computeBatchBuyerTruth({ regionSnapshots: [a, b], monitorRegionCount: 2 });
    expect(r.batchVerificationStatus).toBe("UNVERIFIED");
    expect(r.batchVerificationReason).toContain("wallet_mismatch");
  });
});
