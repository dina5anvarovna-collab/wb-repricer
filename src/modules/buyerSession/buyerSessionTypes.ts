/** Результат buyer probe (карточка + куки + доступ к card API при наличии). */
export type BuyerProbeResult = {
  ok: boolean;
  hasCookieAccess: boolean;
  hasShowcaseAccess: boolean;
  hasDomAccess: boolean;
  reason?: string;
  showcaseHttpStatus?: number;
};

export enum BuyerSessionStatus {
  FRESH = "fresh",
  STALE = "stale",
  INVALID = "invalid",
  NEEDS_REAUTH = "needs_reauth",
  DISABLED = "disabled",
}

/** Статус buyer auth в UI / API (канон — persistent profile + probe). */
export type BuyerAuthCanonicalStatus =
  | BuyerSessionStatus
  | "unknown";

/** Насколько можно доверять cookie header без повторного probe. */
export type BuyerCookieValidation = "fresh" | "stale" | "none";

export type BuyerCookiePipelineResult = {
  header: string | null;
  validation: BuyerCookieValidation;
  reason: string | null;
};
