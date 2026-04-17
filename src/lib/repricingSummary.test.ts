import { describe, expect, it } from "vitest";
import { computeRepricingSummary, type RepricingRegionInput } from "./repricingSummary.js";

function baseRegions(): RepricingRegionInput[] {
  return [
    {
      dest: "-1257786",
      label: "Москва",
      walletPriceRub: 375,
      regularPriceRub: 387,
      verificationStatus: "VERIFIED",
      source: "product_page_wallet_selector",
    },
    {
      dest: "-2133462",
      label: "Казань",
      walletPriceRub: 382,
      regularPriceRub: 398,
      verificationStatus: "VERIFIED",
      source: "product_page_wallet_selector",
    },
    {
      dest: "-1059500",
      label: "СПб",
      walletPriceRub: 379,
      regularPriceRub: 393,
      verificationStatus: "VERIFIED",
      source: "product_page_wallet_selector",
    },
  ];
}

describe("computeRepricingSummary", () => {
  it("all regions filled -> enough_data + no_change", () => {
    const out = computeRepricingSummary({
      regions: baseRegions(),
      sellerMinPriceRub: 360,
      sellerCabinetPriceRub: 550,
      safeModeRecommendationOnly: true,
    });
    expect(out.minWalletPriceRub).toBe(375);
    expect(out.minWalletRegion).toBe("Москва");
    expect(out.minNoWalletPriceRub).toBe(387);
    expect(out.repricingDecision).toBe("no_change");
    expect(out.repricingStatus).toBe("enough_data");
    expect(out.recommendedCabinetPriceRub).toBe(550);
  });

  it("part of regions empty -> still enough_data if verified minimum exists", () => {
    const rows = baseRegions();
    rows[1] = {
      ...rows[1],
      walletPriceRub: null,
      regularPriceRub: null,
      verificationStatus: null,
    };
    const out = computeRepricingSummary({
      regions: rows,
      sellerMinPriceRub: 370,
      sellerCabinetPriceRub: 530,
      safeModeRecommendationOnly: true,
    });
    expect(out.minWalletPriceRub).toBe(375);
    expect(out.repricingDecision).toBe("no_change");
    expect(out.repricingStatus).toBe("enough_data");
  });

  it("same wallet across regions + unverified row -> ambiguity_warning", () => {
    const rows = baseRegions().map((x) => ({ ...x, walletPriceRub: 375 }));
    rows[2] = { ...rows[2], verificationStatus: "UNVERIFIED" };
    const out = computeRepricingSummary({
      regions: rows,
      sellerMinPriceRub: 350,
      sellerCabinetPriceRub: 500,
      safeModeRecommendationOnly: true,
    });
    expect(out.minWalletPriceRub).toBe(375);
    expect(out.repricingDecision).toBe("no_change");
    expect(out.repricingStatus).toBe("ambiguity_warning");
  });

  it("wallet lower than min price -> raise_price", () => {
    const out = computeRepricingSummary({
      regions: baseRegions(),
      sellerMinPriceRub: 420,
      sellerCabinetPriceRub: 500,
      safeModeRecommendationOnly: true,
    });
    expect(out.repricingDecision).toBe("raise_price");
    expect(out.recommendedCabinetPriceRub).toBe(545);
  });

  it("wallet equals min price -> no_change", () => {
    const out = computeRepricingSummary({
      regions: baseRegions(),
      sellerMinPriceRub: 375,
      sellerCabinetPriceRub: 520,
      safeModeRecommendationOnly: true,
    });
    expect(out.repricingDecision).toBe("no_change");
    expect(out.recommendedCabinetPriceRub).toBe(520);
  });

  it("wallet above min price -> no_change", () => {
    const out = computeRepricingSummary({
      regions: baseRegions(),
      sellerMinPriceRub: 340,
      sellerCabinetPriceRub: 520,
      safeModeRecommendationOnly: true,
    });
    expect(out.repricingDecision).toBe("no_change");
    expect(out.repricingStatus).toBe("enough_data");
  });

  it("no verified wallet prices -> insufficient_data", () => {
    const out = computeRepricingSummary({
      regions: baseRegions().map((r) => ({ ...r, verificationStatus: "UNVERIFIED" as const })),
      sellerMinPriceRub: 375,
      sellerCabinetPriceRub: 520,
      safeModeRecommendationOnly: true,
    });
    expect(out.repricingDecision).toBe("insufficient_data");
    expect(out.repricingStatus).toBe("insufficient_data");
    expect(out.recommendedCabinetPriceRub).toBeNull();
  });
});
