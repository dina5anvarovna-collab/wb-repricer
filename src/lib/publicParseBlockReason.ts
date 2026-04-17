/**
 * Уточнённая классификация результата публичного парсинга WB (диагностика блоков).
 * Поле legacyParseStatus сохраняет совместимость с существующими счётчиками и БД.
 */

export type PublicParseBlockReason =
  | "ok"
  | "captcha"
  | "anti_bot_page"
  | "page_blocked"
  | "unexpected_redirect"
  | "selector_missing"
  | "timeout"
  | "http_error"
  | "auth_required"
  | "unexpected";

export type DetectBlockInput = {
  bodyText: string;
  pageUrl: string;
  expectedNmId?: number | null;
  /** HTTP статус главной навигации, если известен */
  mainResponseStatus?: number | null;
};

export function detectPublicParseBlockSignals(input: DetectBlockInput): {
  reason: PublicParseBlockReason;
  legacyParseStatus: "blocked_or_captcha" | "auth_required" | null;
} {
  const u = input.pageUrl.toLowerCase();
  const t = input.bodyText.slice(0, 14_000);

  const status = input.mainResponseStatus;
  if (typeof status === "number" && (status >= 400 || status === 0)) {
    return { reason: "http_error", legacyParseStatus: null };
  }

  if (/капч|captcha|вы\s+робот|подтвердите,\s*что\s+вы\s+не\s+робот|smartcaptcha/i.test(t)) {
    return { reason: "captcha", legacyParseStatus: "blocked_or_captcha" };
  }

  if (
    /доступ\s+ограничен|слишком\s+частые\s+запросы|попробуйте\s+чуть\s+позже|temporarily\s+unavailable|429|anti.?bot|заблокирован/i.test(
      t,
    ) ||
    /cf-ray|challenge-platform|__cf_chl/i.test(t)
  ) {
    return { reason: "anti_bot_page", legacyParseStatus: "blocked_or_captcha" };
  }

  if (
    /security\/login|passport\.wildberries|oauth\.wildberries/i.test(u) ||
    (t.length < 500 &&
      /войти\s+по\s+коду|вход\s+или\s+регистрация/i.test(t) &&
      !/\/catalog\/\d+\//i.test(u))
  ) {
    return { reason: "auth_required", legacyParseStatus: "auth_required" };
  }

  if (
    input.expectedNmId != null &&
    /\/catalog\/\d+\//i.test(u) &&
    !new RegExp(`/catalog/${input.expectedNmId}/`, "i").test(u)
  ) {
    return { reason: "unexpected_redirect", legacyParseStatus: "blocked_or_captcha" };
  }

  if (t.length < 120 && !/wildberries|wb\.ru/i.test(t)) {
    return { reason: "page_blocked", legacyParseStatus: "blocked_or_captcha" };
  }

  return { reason: "ok", legacyParseStatus: null };
}

export function mapErrorToBlockReason(err: unknown): PublicParseBlockReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|TimeoutError/i.test(msg)) {
    return "timeout";
  }
  if (/net::|ERR_|NS_ERROR|Navigation failed|EAI_AGAIN/i.test(msg)) {
    return "http_error";
  }
  return "unexpected";
}

export function shouldRetryPublicParse(blockReason: PublicParseBlockReason | undefined | null): boolean {
  if (!blockReason || blockReason === "ok") return false;
  if (
    blockReason === "timeout" ||
    blockReason === "selector_missing" ||
    blockReason === "anti_bot_page" ||
    blockReason === "page_blocked" ||
    blockReason === "unexpected" ||
    blockReason === "http_error"
  ) {
    return true;
  }
  return false;
}
