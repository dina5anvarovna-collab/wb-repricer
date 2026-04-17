/**
 * Production rules: confidence gating, last-good TTL, enforcement decisions.
 */

export const CONF_POPUP_DOM = 1.0;
export const CONF_PUBLIC_WALLET_MARKER = 0.8;
export const CONF_PARTIAL_DOM = 0.5;
export const CONF_FAILED = 0.0;

export const THRESHOLD_DECREASE = 0.8;
export const THRESHOLD_PROTECTIVE = 0.5;

/** Last good wallet age buckets (hours). */
export const LAST_GOOD_FULL_SAFE_H = 2;
export const LAST_GOOD_PROTECT_ONLY_H = 24;

export type LastGoodTtlBand = "fresh" | "protect_only" | "expired";

export function hoursSince(date: Date | null | undefined): number | null {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return (Date.now() - date.getTime()) / 3_600_000;
}

export function lastGoodTtlBand(at: Date | null | undefined): LastGoodTtlBand {
  const h = hoursSince(at);
  if (h == null || h < 0) return "expired";
  if (h <= LAST_GOOD_FULL_SAFE_H) return "fresh";
  if (h <= LAST_GOOD_PROTECT_ONLY_H) return "protect_only";
  return "expired";
}

/** Numeric 0..1 from monitor tier + parse outcome. */
export function walletParseNumericConfidence(input: {
  priceParseSource: string | null | undefined;
  parseStatus: string | null | undefined;
  walletMarkerDetected: boolean;
  popupParsed: boolean;
  partialDom: boolean;
}): number {
  if (
    input.parseStatus === "parse_failed" ||
    input.parseStatus === "auth_required" ||
    input.parseStatus === "blocked_or_captcha"
  ) {
    return CONF_FAILED;
  }
  if (input.popupParsed || input.priceParseSource === "popup_dom") {
    return CONF_POPUP_DOM;
  }
  if (input.partialDom || input.parseStatus === "only_regular_found") {
    return CONF_PARTIAL_DOM;
  }
  if (input.priceParseSource === "public_dom" && input.walletMarkerDetected) {
    return CONF_PUBLIC_WALLET_MARKER;
  }
  if (input.priceParseSource === "public_dom") {
    return CONF_PARTIAL_DOM;
  }
  return CONF_PARTIAL_DOM;
}

export function allowsProtectiveAction(confidence: number): boolean {
  return confidence >= THRESHOLD_PROTECTIVE;
}

export function allowsAutomaticPriceDecrease(confidence: number): boolean {
  return confidence >= THRESHOLD_DECREASE;
}

/** Можно ли подставлять last-good walletRub в мониторинг (по возрасту записи). */
export function lastGoodSubstitutionMode(
  walletRubLastGoodAt: Date | null | undefined,
): "full" | "protect_only" | "none" {
  const band = lastGoodTtlBand(walletRubLastGoodAt ?? null);
  if (band === "fresh") return "full";
  if (band === "protect_only") return "protect_only";
  return "none";
}
