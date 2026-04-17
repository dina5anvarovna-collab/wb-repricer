import { describe, expect, it } from "vitest";
import { applyRounding, computeProtectionRaise, pickObservedFinalPrice } from "./engine.js";

describe("pickObservedFinalPrice", () => {
  it("prefers wallet", () => {
    const r = pickObservedFinalPrice({
      observedWalletPrice: 1500,
      observedDiscountedPrice: 1800,
      currentBasePrice: 2000,
      currentDiscountPercent: 10,
    });
    expect(r.final).toBe(1500);
    expect(r.source).toBe("wallet");
  });

  it("uses discounted when no wallet", () => {
    const r = pickObservedFinalPrice({
      observedWalletPrice: null,
      observedDiscountedPrice: 1700,
      currentBasePrice: 2000,
      currentDiscountPercent: 15,
    });
    expect(r.final).toBe(1700);
  });
});

describe("computeProtectionRaise observed mode", () => {
  it("raises base when final below min (пример из ТЗ)", () => {
    const res = computeProtectionRaise({
      minAllowedFinalPrice: 1800,
      currentBasePrice: 2000,
      currentDiscountPercent: 0,
      observedWalletPrice: 1680,
      observedDiscountedPrice: null,
      safetyBufferPercent: 0,
      roundingMode: "integer",
      maxIncreasePercentPerCycle: 50,
      maxIncreaseAbsolute: 50_000,
      minChangeThreshold: 1,
      minutesSinceLastRaise: null,
      cooldownMinutes: 0,
      priceToleranceRub: 0,
      enforcementMode: true,
      walletParseConfidence: 0.9,
      minWalletConfidence: 0.5,
    });
    expect(res.action).toBe("propose");
    expect(res.newBasePrice).toBeGreaterThanOrEqual(2142);
    expect(res.reason).toMatch(/Кошелёк|Observed/i);
    expect(res.reasonCode).toBe("below_min_raise_proposed");
  });

  it("no change when above min", () => {
    const res = computeProtectionRaise({
      minAllowedFinalPrice: 1500,
      currentBasePrice: 2000,
      currentDiscountPercent: 10,
      observedWalletPrice: 1600,
      observedDiscountedPrice: null,
      safetyBufferPercent: 2,
      roundingMode: "integer",
      maxIncreasePercentPerCycle: 20,
      maxIncreaseAbsolute: 5000,
      minChangeThreshold: 5,
      minutesSinceLastRaise: null,
      cooldownMinutes: 0,
      priceToleranceRub: 3,
      enforcementMode: true,
      walletParseConfidence: 0.85,
      minWalletConfidence: 0.5,
    });
    expect(res.action).toBe("no_change");
    expect(res.reasonCode).toBe("target_met");
  });

  it("enforcement: skip when no wallet even if discounted exists", () => {
    const res = computeProtectionRaise({
      minAllowedFinalPrice: 2000,
      currentBasePrice: 3000,
      currentDiscountPercent: 10,
      observedWalletPrice: null,
      observedDiscountedPrice: 1500,
      safetyBufferPercent: 0,
      roundingMode: "integer",
      maxIncreasePercentPerCycle: 50,
      maxIncreaseAbsolute: 50_000,
      minChangeThreshold: 1,
      minutesSinceLastRaise: null,
      cooldownMinutes: 0,
      priceToleranceRub: 0,
      enforcementMode: true,
    });
    expect(res.action).toBe("skip");
    expect(res.reasonCode).toBe("skipped_no_wallet");
  });
});

describe("applyRounding", () => {
  it("end9", () => {
    expect(applyRounding(2143, "end9")).toBe(2149);
  });

  it("never rounds down for tens/end90", () => {
    expect(applyRounding(101, "tens")).toBe(110);
    expect(applyRounding(191, "end90")).toBe(290);
  });
});

describe("computeProtectionRaise safety", () => {
  it("skips when caps prevent reaching minimum", () => {
    const res = computeProtectionRaise({
      minAllowedFinalPrice: 900,
      currentBasePrice: 1000,
      currentDiscountPercent: 0,
      observedWalletPrice: 800,
      observedDiscountedPrice: null,
      safetyBufferPercent: 0,
      roundingMode: "integer",
      maxIncreasePercentPerCycle: 10,
      maxIncreaseAbsolute: 100,
      minChangeThreshold: 1,
      minutesSinceLastRaise: null,
      cooldownMinutes: 0,
      priceToleranceRub: 0,
      enforcementMode: true,
      walletParseConfidence: 0.9,
      minWalletConfidence: 0.5,
    });
    expect(res.action).toBe("skip");
    expect(res.reasonCode).toBe("skipped_cannot_reach_min");
  });
});
