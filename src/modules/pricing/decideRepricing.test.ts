import { describe, expect, it } from "vitest";
import { decideRepricing } from "./decideRepricing.js";
import type { WalletEvidence } from "./walletEvidence.js";

function evidence(overrides?: Partial<WalletEvidence>): WalletEvidence {
  return {
    walletRub: 1176,
    showcaseRub: 1176,
    nonWalletRub: 1200,
    regularRub: 1500,
    source: "dom",
    sourceConfidence: "high",
    confirmed: true,
    parseStatus: "success",
    region: "-1257786",
    nmId: 396186475,
    observedAt: new Date().toISOString(),
    conflict: false,
    level: "actionable",
    actionable: true,
    ...overrides,
  };
}

describe("decideRepricing", () => {
  it("enforces on normal actionable case", () => {
    const out = decideRepricing({
      sellerPriceRub: 1500,
      floorRub: 1100,
      walletEvidence: evidence(),
      sessionStatus: "fresh",
      stock: "IN_STOCK",
      freshness: { isFresh: true, ageMinutes: 2 },
    });
    expect(out.action).toBe("enforce_now");
  });

  it("skips stale case", () => {
    const out = decideRepricing({
      sellerPriceRub: 1500,
      floorRub: 1100,
      walletEvidence: evidence(),
      sessionStatus: "stale",
      stock: "IN_STOCK",
      freshness: { isFresh: false, ageMinutes: 90 },
    });
    expect(out.action).toBe("skip_stale");
  });

  it("skips conflicts with safe hold", () => {
    const out = decideRepricing({
      sellerPriceRub: 1500,
      floorRub: 1100,
      walletEvidence: evidence({ conflict: true, actionable: false, level: "confirmed" }),
      sessionStatus: "fresh",
      stock: "IN_STOCK",
      freshness: { isFresh: true, ageMinutes: 1 },
    });
    expect(out.action).toBe("skip_conflict");
    expect(out.status).toBe("safe_hold");
  });

  it("skips invalid session", () => {
    const out = decideRepricing({
      sellerPriceRub: 1500,
      floorRub: 1100,
      walletEvidence: evidence(),
      sessionStatus: "invalid",
      stock: "IN_STOCK",
      freshness: { isFresh: true, ageMinutes: 1 },
    });
    expect(out.action).toBe("skip_invalid_session");
  });

  it("skips when wallet is missing/not actionable", () => {
    const out = decideRepricing({
      sellerPriceRub: 1500,
      floorRub: 1100,
      walletEvidence: evidence({ walletRub: null, actionable: false, level: "observed", confirmed: false }),
      sessionStatus: "fresh",
      stock: "IN_STOCK",
      freshness: { isFresh: true, ageMinutes: 1 },
    });
    expect(out.action).toBe("skip_safe_hold");
  });
});

