import type { WalletParserResult } from "../walletDom/wbWalletPriceParser.js";
import type { ShowcaseOrchestratorResult } from "../walletDom/priceSourceResolver.js";

export type NonWalletRubDetail = {
  nonWalletRub: number | null;
  /** Диагностика: почему выбрано значение */
  nonWalletEvidence: string | null;
  /** Короткий код источника для downstream */
  nonWalletSource: string | null;
  /** Карточный/API fallback (не spp DOM и не buyer verification priceWithoutWallet). */
  nonWalletFallbackUsed: string | null;
  /** Все значимые кандидаты для диагностики parse-probe */
  nonWalletCandidateValues: Record<string, number | null>;
};

function toRub(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function apiWalletChain(base: WalletParserResult, orc: ShowcaseOrchestratorResult | null): number | null {
  return toRub(orc?.apiWalletRub) ?? toRub(base.apiWalletRub) ?? toRub(base.cardApiWalletRub);
}

/** Прямой витринный рубль с card.wb.ru (без orc.apiShowcaseRub, который может совпадать с кошельком). */
function cardApiShowcaseDirect(base: WalletParserResult): number | null {
  return toRub(base.cardApiShowcaseRub) ?? toRub(base.showcaseRubFromCardApi);
}

const CARD_FALLBACK_EVIDENCE = new Set([
  "card_api_wallet_pair_delta",
  "card_showcase_above_walletRub",
]);

/**
 * Единая цепочка кандидатов «цена без WB Кошелька, с СПП» (cookies / buyer / card).
 * Не используем popup «Детализация цены» — он только для валидации кошелька (см. finalizeRepricerPriceSemantics).
 *
 * Карточный tier (cardApiShowcaseRub / showcaseRubFromCardApi) используется только если **строго выше**
 * walletRub (или цены кошелька из результата): раньше apiShowcaseChain брал orc.apiShowcaseRub первым и «глушил»
 * большую цену без кошелька из card API.
 */
export function resolveNonWalletRubDetailed(
  base: WalletParserResult,
  orc: ShowcaseOrchestratorResult | null,
  walletLineForCross: number | null,
): NonWalletRubDetail {
  const wl = walletLineForCross;

  const sppDom = toRub(base.priceWithSppWithoutWalletRub);
  const bpvPw = toRub(base.buyerPriceVerification?.priceWithoutWallet);

  const cardShowcaseDirect = cardApiShowcaseDirect(base);
  const cardWalDirect = apiWalletChain(base, orc);

  const walletRubRef = toRub(base.walletRub) ?? toRub(base.priceWallet) ?? wl;

  const candidateValues: Record<string, number | null> = {
    priceWithSppWithoutWalletRub: sppDom,
    buyerPriceVerification_priceWithoutWallet: bpvPw,
    cardApiShowcaseRub: toRub(base.cardApiShowcaseRub),
    showcaseRubFromCardApi: toRub(base.showcaseRubFromCardApi),
    cardShowcaseDirect,
    cardApiWalletRub: toRub(base.cardApiWalletRub),
    apiWalletRub: toRub(base.apiWalletRub),
    walletRubRef,
    walletLineForCross: wl,
    verifiedLocalWithoutWalletRub: toRub(orc?.verifiedLocalWithoutWalletRub),
    parser_nonWalletRub_field: toRub(base.nonWalletRub),
  };

  type TryRow = { rub: number; ev: string; src: string };

  const tries: TryRow[] = [];

  /**
   * Приоритет (явный контракт):
   * 1) priceWithSppWithoutWalletRub — DOM/orchestrator (без popup как основного источника)
   * 2) buyerPriceVerification.priceWithoutWallet — buyer session / cookies
   * 3) verified local / карточный tier / DOM nonWalletRub — см. порядок ниже
   */
  if (sppDom != null) {
    tries.push({
      rub: sppDom,
      ev: "dom_price_with_spp_without_wallet",
      src: "priceWithSppWithoutWalletRub",
    });
  }

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

  if (cardShowcaseDirect != null && cardWalDirect != null && cardShowcaseDirect > cardWalDirect) {
    tries.push({
      rub: cardShowcaseDirect,
      ev: "card_api_wallet_pair_delta",
      src: "cardApiShowcaseRub/showcaseRubFromCardApi vs cardWallet",
    });
  }

  if (walletRubRef != null && cardShowcaseDirect != null && cardShowcaseDirect > walletRubRef) {
    tries.push({
      rub: cardShowcaseDirect,
      ev: "card_showcase_above_walletRub",
      src: "cardApiShowcaseRub/showcaseRubFromCardApi > walletRub",
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

  const first = tries[0];

  if (first == null) {
    return {
      nonWalletRub: null,
      nonWalletEvidence: null,
      nonWalletSource: null,
      nonWalletFallbackUsed: null,
      nonWalletCandidateValues: candidateValues,
    };
  }

  const fallbackUsed = CARD_FALLBACK_EVIDENCE.has(first.ev) ? first.ev : null;

  return {
    nonWalletRub: first.rub,
    nonWalletEvidence: first.ev,
    nonWalletSource: first.src,
    nonWalletFallbackUsed: fallbackUsed,
    nonWalletCandidateValues: candidateValues,
  };
}
