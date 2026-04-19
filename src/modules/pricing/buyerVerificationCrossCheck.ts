import type { BuyerPriceVerificationSnapshot } from "./buyerPriceVerification.js";

/** Блокеры: при наличии любого из них DOM wallet не считается verified buyer truth. */
export const BUYER_TRUTH_BLOCKERS = new Set([
  "region_price_ambiguous",
  "region_not_confirmed",
  "dest_not_applied",
  "dest_mismatch",
  "nmid_mismatch",
  "invalid_wallet_price",
  "invalid_price_with_spp_lt_wallet",
  "spp_missing_cookie_showcase",
  "spp_missing",
  "spp_invalid_range",
  "showcase_vs_seller_anomaly",
  "showcase_jump_anomaly",
]);

const WEAK_PARSE_STATUSES = new Set([
  "blocked_or_captcha",
  "parse_failed",
  "auth_required",
  "loaded_no_price",
  "loaded_showcase_only",
]);

export type BuyerDomCrossCheckInput = {
  parseStatus?: string | null;
  regionPriceAmbiguous?: boolean | null;
  sourceConflictDetected?: boolean | null;
};

/**
 * Финальный шаг верификации: не поднимать VERIFIED, пока не пройден cross-check
 * с регионом, safety rules, парс-статусом и конфликтом источников.
 */
export function applyBuyerVerificationCrossCheck(
  dom: BuyerDomCrossCheckInput,
  verification: BuyerPriceVerificationSnapshot,
  blockedBySafetyRule: string[],
): BuyerPriceVerificationSnapshot {
  if (verification.verificationStatus !== "VERIFIED") {
    return verification;
  }

  const parseStatus = typeof dom.parseStatus === "string" ? dom.parseStatus : "";
  const blockedHit = blockedBySafetyRule.some((b) => BUYER_TRUTH_BLOCKERS.has(b));
  const weakParse = WEAK_PARSE_STATUSES.has(parseStatus);
  const ambiguousRegion = dom.regionPriceAmbiguous === true;
  const conflict = dom.sourceConflictDetected === true;

  if (!blockedHit && !weakParse && !ambiguousRegion && !conflict) {
    return verification;
  }

  const parts: string[] = [];
  if (blockedHit) {
    parts.push(
      `cross_check_blocked:${blockedBySafetyRule.filter((b) => BUYER_TRUTH_BLOCKERS.has(b)).join(",")}`,
    );
  }
  if (weakParse) parts.push(`weak_parse_status:${parseStatus}`);
  if (ambiguousRegion) parts.push("region_price_ambiguous_signal");
  if (conflict) parts.push("source_conflict_detected");

  return {
    ...verification,
    verificationStatus: "UNVERIFIED",
    verificationReason: [verification.verificationReason, ...parts].filter(Boolean).join(";"),
    repricingAllowed: false,
    trustedSource: "none",
    verificationMethod: "unverified",
    showcaseWalletPrice: null,
    walletPriceVerified: null,
  };
}

/**
 * Можно ли считать wallet/showcase колонки снимка подтверждённым buyer truth (персистенция / last good).
 */
export function canPersistVerifiedWalletTruth(input: {
  verification: BuyerPriceVerificationSnapshot;
  blockedBySafetyRule: string[];
  regionPriceAmbiguous: boolean | null | undefined;
  parseStatus: string | null | undefined;
}): boolean {
  if (input.verification.verificationStatus !== "VERIFIED") return false;
  if (input.blockedBySafetyRule.some((b) => BUYER_TRUTH_BLOCKERS.has(b))) return false;
  if (input.regionPriceAmbiguous === true) return false;
  const ps = typeof input.parseStatus === "string" ? input.parseStatus : "";
  if (WEAK_PARSE_STATUSES.has(ps)) return false;
  return true;
}
