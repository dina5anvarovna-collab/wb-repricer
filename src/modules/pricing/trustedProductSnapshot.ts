import type { PriceSnapshot, WbProduct } from "@prisma/client";
import type { ResolvedObservedBuyerPrices } from "./resolveObservedBuyerPrices.js";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";
export type FrontStatus = "VERIFIED" | "PARTIAL" | "UNVERIFIED";

export type SellerSnapshot = {
  nmId: number;
  sellerPriceRub: number | null;
  sellerDiscountPriceRub: number | null;
  status: "ok" | "missing";
  error: string | null;
};

export type BuyerRegionalSnapshot = {
  nmId: number;
  dest: string | null;
  showcaseWithWalletRub: number | null;
  priceWithSppRub: number | null;
  sppRub: number | null;
  verificationStatus: "VERIFIED" | "UNVERIFIED";
  regionConfirmed: boolean | null;
  regionPriceAmbiguous: boolean | null;
  confidenceLevel: ConfidenceLevel;
  source: string;
  parseError: string | null;
  inStock: boolean | null;
  timestamp: string;
};

export type TrustedProductSnapshot = {
  nmId: number;
  sellerPriceRub: number | null;
  sellerDiscountPriceRub: number | null;
  aggregatedSppRub: number | null;
  aggregatedShowcaseWithWalletRub: number | null;
  aggregatedPriceWithSppRub: number | null;
  sppPercent: number | null;
  walletDiscountRub: number | null;
  walletDiscountPercent: number | null;
  validRegionsCount: number;
  totalRegionsCount: number;
  frontStatus: FrontStatus;
  confidenceLevel: ConfidenceLevel;
  verificationSource: string | null;
  repricingAllowed: boolean;
  repricingAllowedReason: string;
  blockedBySafetyRule: string[];
};

function toRub(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
}

function toConfidence(v: string | null | undefined): ConfidenceLevel {
  if (v === "HIGH" || v === "MEDIUM" || v === "LOW") return v;
  return "LOW";
}

function parseDetailJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function buildSellerSnapshotFromProduct(p: WbProduct): SellerSnapshot {
  const sellerPriceRub = toRub(p.sellerPrice);
  const sellerDiscountPriceRub = toRub(p.discountedPriceRub);
  return {
    nmId: p.nmId,
    sellerPriceRub,
    sellerDiscountPriceRub,
    status: sellerPriceRub != null || sellerDiscountPriceRub != null ? "ok" : "missing",
    error: sellerPriceRub != null || sellerDiscountPriceRub != null ? null : "seller_api_missing_prices",
  };
}

export function buildBuyerRegionalSnapshotFromResolved(input: {
  nmId: number;
  dest: string | null;
  resolved: ResolvedObservedBuyerPrices;
  parseError: string | null;
  inStock: boolean | null;
  timestampIso: string;
}): BuyerRegionalSnapshot {
  const { resolved } = input;
  return {
    nmId: input.nmId,
    dest: input.dest,
    showcaseWithWalletRub: toRub(resolved.showcasePriceRub ?? resolved.showcaseRub),
    priceWithSppRub: toRub(resolved.priceWithSppWithoutWalletRub ?? resolved.priceWithoutWalletRub),
    sppRub: toRub(resolved.sppRub),
    verificationStatus: resolved.buyerPriceVerification.verificationStatus,
    regionConfirmed: resolved.regionConfirmed ?? null,
    regionPriceAmbiguous: resolved.regionPriceAmbiguous ?? null,
    confidenceLevel: resolved.confidence,
    source: resolved.trustedSource !== "none" ? resolved.trustedSource : resolved.verificationSource ?? "unverified",
    parseError: input.parseError,
    inStock: input.inStock,
    timestamp: input.timestampIso,
  };
}

export function buildBuyerRegionalSnapshotFromPriceSnapshot(s: PriceSnapshot): BuyerRegionalSnapshot {
  const dj = parseDetailJson(s.detailJson);
  const confidenceLevel = toConfidence(typeof dj.confidence === "string" ? dj.confidence : null);
  const verificationStatus =
    dj.buyerPriceVerification &&
    typeof dj.buyerPriceVerification === "object" &&
    (dj.buyerPriceVerification as Record<string, unknown>).verificationStatus === "VERIFIED"
      ? "VERIFIED"
      : dj.regionalVerificationStatus === "VERIFIED"
        ? "VERIFIED"
        : "UNVERIFIED";
  const parseError =
    typeof s.errorMessage === "string" && s.errorMessage.trim().length > 0 ? s.errorMessage : null;
  return {
    nmId: s.nmId,
    dest: s.regionDest?.trim() || null,
    showcaseWithWalletRub: toRub(s.showcaseRub ?? s.buyerWalletPrice),
    priceWithSppRub: toRub(s.nonWalletRub ?? s.buyerRegularPrice),
    sppRub:
      toRub(
        typeof dj.sppRub === "number" && Number.isFinite(dj.sppRub)
          ? dj.sppRub
          : null,
      ),
    verificationStatus,
    regionConfirmed:
      typeof dj.regionConfirmed === "boolean" ? dj.regionConfirmed : null,
    regionPriceAmbiguous:
      typeof dj.regionPriceAmbiguous === "boolean" ? dj.regionPriceAmbiguous : null,
    confidenceLevel,
    source:
      typeof dj.trustedSource === "string" && dj.trustedSource.trim().length > 0
        ? dj.trustedSource
        : typeof dj.verificationSource === "string"
          ? dj.verificationSource
          : "unverified",
    parseError,
    inStock: null,
    timestamp: s.parsedAt.toISOString(),
  };
}

export function aggregateTrustedProductSnapshot(input: {
  nmId: number;
  seller: SellerSnapshot;
  regional: BuyerRegionalSnapshot[];
  totalRegionsCount: number;
  minVerifiedRegions: number;
}): TrustedProductSnapshot {
  const trustedRegional = input.regional.filter(
    (r) =>
      r.regionConfirmed === true &&
      r.verificationStatus === "VERIFIED" &&
      r.regionPriceAmbiguous !== true &&
      (r.confidenceLevel === "HIGH" || r.confidenceLevel === "MEDIUM") &&
      r.showcaseWithWalletRub != null,
  );
  const validRegionsCount = trustedRegional.length;
  const totalRegionsCount = Math.max(input.totalRegionsCount, input.regional.length);
  let frontStatus: FrontStatus = "UNVERIFIED";
  if (validRegionsCount > 0) {
    frontStatus = validRegionsCount < totalRegionsCount ? "PARTIAL" : "VERIFIED";
  }
  const blockedBySafetyRule: string[] = [];
  if (validRegionsCount < input.minVerifiedRegions) {
    blockedBySafetyRule.push("insufficient_verified_regions");
  }
  if (validRegionsCount === 0) {
    blockedBySafetyRule.push("no_trusted_regions");
  }
  const minRegion =
    trustedRegional.length > 0
      ? trustedRegional.reduce((a, b) => (a.showcaseWithWalletRub! <= b.showcaseWithWalletRub! ? a : b))
      : null;
  const aggregatedShowcaseWithWalletRub = minRegion?.showcaseWithWalletRub ?? null;
  const aggregatedPriceWithSppRub = minRegion?.priceWithSppRub ?? null;
  const aggregatedSppRub = minRegion?.sppRub ?? null;
  const sellerDiscount = input.seller.sellerDiscountPriceRub;
  const sppPercent =
    sellerDiscount != null &&
    aggregatedSppRub != null &&
    sellerDiscount > 0 &&
    aggregatedSppRub >= 0 &&
    aggregatedSppRub <= sellerDiscount
      ? Math.round(((aggregatedSppRub / sellerDiscount) * 100) * 10) / 10
      : null;
  const walletDiscountRub =
    aggregatedPriceWithSppRub != null && aggregatedShowcaseWithWalletRub != null
      ? Math.max(0, Math.round(aggregatedPriceWithSppRub - aggregatedShowcaseWithWalletRub))
      : null;
  const walletDiscountPercent =
    walletDiscountRub != null &&
    aggregatedPriceWithSppRub != null &&
    aggregatedPriceWithSppRub > 0
      ? Math.round(((walletDiscountRub / aggregatedPriceWithSppRub) * 100) * 10) / 10
      : null;
  const confidenceLevel =
    minRegion?.confidenceLevel ??
    (validRegionsCount >= input.minVerifiedRegions ? "MEDIUM" : "LOW");
  return {
    nmId: input.nmId,
    sellerPriceRub: input.seller.sellerPriceRub,
    sellerDiscountPriceRub: input.seller.sellerDiscountPriceRub,
    aggregatedSppRub,
    aggregatedShowcaseWithWalletRub,
    aggregatedPriceWithSppRub,
    sppPercent,
    walletDiscountRub,
    walletDiscountPercent,
    validRegionsCount,
    totalRegionsCount,
    frontStatus,
    confidenceLevel,
    verificationSource: minRegion?.source ?? null,
    repricingAllowed: false,
    repricingAllowedReason: "not_evaluated",
    blockedBySafetyRule,
  };
}

export function evaluateTrustedRepricingDecision(input: {
  trusted: TrustedProductSnapshot;
  minPriceRub: number | null;
}): TrustedProductSnapshot {
  const { trusted, minPriceRub } = input;
  const blocked = [...trusted.blockedBySafetyRule];
  if (minPriceRub == null || !Number.isFinite(minPriceRub) || minPriceRub <= 0) {
    blocked.push("missing_min_price");
    return { ...trusted, repricingAllowed: false, repricingAllowedReason: blocked.join(";"), blockedBySafetyRule: blocked };
  }
  if (trusted.aggregatedShowcaseWithWalletRub == null) {
    blocked.push("missing_trusted_showcase");
    return { ...trusted, repricingAllowed: false, repricingAllowedReason: blocked.join(";"), blockedBySafetyRule: blocked };
  }
  if (trusted.frontStatus === "UNVERIFIED") {
    blocked.push("trusted_snapshot_unverified");
    return { ...trusted, repricingAllowed: false, repricingAllowedReason: blocked.join(";"), blockedBySafetyRule: blocked };
  }
  if (trusted.confidenceLevel !== "HIGH") {
    blocked.push("trusted_confidence_not_high");
    return { ...trusted, repricingAllowed: false, repricingAllowedReason: blocked.join(";"), blockedBySafetyRule: blocked };
  }
  if (trusted.aggregatedShowcaseWithWalletRub >= minPriceRub) {
    blocked.push("showcase_not_below_min");
    return { ...trusted, repricingAllowed: false, repricingAllowedReason: blocked.join(";"), blockedBySafetyRule: blocked };
  }
  return {
    ...trusted,
    repricingAllowed: true,
    repricingAllowedReason: "trusted_showcase_below_min",
    blockedBySafetyRule: blocked,
  };
}
