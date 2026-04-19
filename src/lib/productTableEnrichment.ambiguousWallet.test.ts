import { describe, expect, it } from "vitest";
import { shouldSuppressAmbiguousDomWallet } from "./productTableEnrichment.js";

describe("ambiguous DOM wallet suppression (catalog)", () => {
  it("returns false for VERIFIED", () => {
    expect(
      shouldSuppressAmbiguousDomWallet({
        verificationStatus: "VERIFIED",
        verificationReason: "x",
        repricingAllowed: null,
        verificationSource: null,
        confidence: null,
        repricingAllowedReason: null,
        blockedBySafetyRule: ["region_not_confirmed"],
      }),
    ).toBe(false);
  });

  it("matches region_dom_not_confirmed in reason", () => {
    expect(
      shouldSuppressAmbiguousDomWallet({
        verificationStatus: "UNVERIFIED",
        verificationReason:
          "region_dom_not_confirmed_same_first_visible_and_wallet_cardapi_diff",
        repricingAllowed: false,
        verificationSource: null,
        confidence: null,
        repricingAllowedReason: null,
        blockedBySafetyRule: [],
      }),
    ).toBe(true);
  });

  it("matches blocked region_price_ambiguous", () => {
    expect(
      shouldSuppressAmbiguousDomWallet({
        verificationStatus: "UNVERIFIED",
        verificationReason: null,
        repricingAllowed: null,
        verificationSource: null,
        confidence: null,
        repricingAllowedReason: null,
        blockedBySafetyRule: ["region_price_ambiguous"],
      }),
    ).toBe(true);
  });

  it("does not suppress plain UNVERIFIED without signals", () => {
    expect(
      shouldSuppressAmbiguousDomWallet({
        verificationStatus: "UNVERIFIED",
        verificationReason: null,
        repricingAllowed: null,
        verificationSource: null,
        confidence: null,
        repricingAllowedReason: null,
        blockedBySafetyRule: [],
      }),
    ).toBe(false);
  });
});
