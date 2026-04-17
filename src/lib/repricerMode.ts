import { env } from "../config/env.js";

/** Buyer-auth выключен (PUBLIC ONLY по умолчанию). Явный false — вернуть legacy buyer/cookies. */
export function isBuyerAuthDisabled(): boolean {
  const v = env.REPRICER_DISABLE_BUYER_AUTH.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/** Режим только публичной витрины без card/cookies/showcase API. */
export function isPublicOnlyWalletParse(): boolean {
  const m = env.REPRICER_WALLET_PARSE_MODE.trim().toLowerCase();
  return isBuyerAuthDisabled() || m === "public_only" || m.startsWith("public_only");
}

/** Предпочитать открытие popup детализации сразу после загрузки карточки. */
export function walletDetailsPopupFirst(): boolean {
  return env.REPRICER_WALLET_DETAILS_MODE.trim().toLowerCase() === "popup_first";
}
