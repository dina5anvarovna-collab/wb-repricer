import type { WalletParserResult } from "../walletDom/wbWalletPriceParser.js";
import type { ShowcaseOrchestratorResult } from "../walletDom/priceSourceResolver.js";

export type NonWalletRubDetail = {
  nonWalletRub: number | null;
  /** Диагностика: почему выбрано значение */
  nonWalletEvidence: string | null;
  /** Короткий код источника для downstream */
  nonWalletSource: string | null;
};

function toRub(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function apiShowcaseChain(base: WalletParserResult, orc: ShowcaseOrchestratorResult | null): number | null {
  return (
    toRub(orc?.apiShowcaseRub) ??
    toRub(base.cardApiShowcaseRub) ??
    toRub(base.showcaseApiRub) ??
    toRub(base.showcaseRubFromCookies)
  );
}

function apiWalletChain(base: WalletParserResult, orc: ShowcaseOrchestratorResult | null): number | null {
  return toRub(orc?.apiWalletRub) ?? toRub(base.apiWalletRub) ?? toRub(base.cardApiWalletRub);
}

/**
 * Единая цепочка кандидатов «цена без WB Кошелька, с СПП» (cookies / buyer / card).
 * Не используем popup «Детализация цены» — он только для валидации кошелька (см. finalizeRepricerPriceSemantics).
 */
export function resolveNonWalletRubDetailed(
  base: WalletParserResult,
  orc: ShowcaseOrchestratorResult | null,
  walletLineForCross: number | null,
): NonWalletRubDetail {
  const apiShowcase = apiShowcaseChain(base, orc);
  const apiWallet = apiWalletChain(base, orc);

  const tries: Array<{ rub: number | null; ev: string; src: string }> = [];

  /**
   * Приоритет (явный контракт):
   * 1) priceWithSppWithoutWalletRub — DOM/orchestrator (без popup как основного источника)
   * 2) buyerPriceVerification.priceWithoutWallet — buyer session / cookies
   * 3) остальное — card/local/DOM field
   */
  const sppDom = toRub(base.priceWithSppWithoutWalletRub);
  if (sppDom != null) {
    tries.push({
      rub: sppDom,
      ev: "dom_price_with_spp_without_wallet",
      src: "priceWithSppWithoutWalletRub",
    });
  }

  const bpvPw = toRub(base.buyerPriceVerification?.priceWithoutWallet);
  if (bpvPw != null) {
    tries.push({
      rub: bpvPw,
      ev: "buyer_verification_price_without_wallet",
      src: "buyerPriceVerification.priceWithoutWallet",
    });
  }

  const vOrb = toRub(orc?.verifiedLocalWithoutWalletRub);
  if (vOrb != null) {
    tries.push({
      rub: vOrb,
      ev: "verified_local_without_wallet",
      src: "orc.verifiedLocalWithoutWalletRub",
    });
  }

  if (apiShowcase != null && apiWallet != null && apiShowcase > apiWallet) {
    tries.push({
      rub: apiShowcase,
      ev: "card_api_wallet_pair_delta",
      src: "card.wb.ru (showcaseRub > walletRub)",
    });
  }

  const wl = walletLineForCross;
  if (wl != null && apiShowcase != null && apiShowcase > wl) {
    tries.push({
      rub: apiShowcase,
      ev: "card_showcase_above_dom_wallet_line",
      src: "card.wb.ru apiShowcase > DOM wallet line",
    });
  }

  const parsedField = toRub(base.nonWalletRub);
  if (parsedField != null) {
    tries.push({
      rub: parsedField,
      ev: "parser_non_wallet_field",
      src: "nonWalletRub (DOM/buildWalletResult)",
    });
  }

  const first = tries.find((t) => t.rub != null);
  if (first != null) {
    return {
      nonWalletRub: first.rub,
      nonWalletEvidence: first.ev,
      nonWalletSource: first.src,
    };
  }

  return { nonWalletRub: null, nonWalletEvidence: null, nonWalletSource: null };
}
