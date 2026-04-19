import type { WalletParserResult } from "../walletDom/wbWalletPriceParser.js";
import type { ShowcaseOrchestratorResult } from "../walletDom/priceSourceResolver.js";

export type NonWalletRubDetail = {
  nonWalletRub: number | null;
  /** Диагностика: почему выбрано значение */
  nonWalletEvidence: string | null;
  /** Короткий код источника для downstream */
  nonWalletSource: string | null;
  /** Сработал финальный fallback по cardApiShowcaseRub vs walletRub */
  nonWalletFallbackUsed: boolean;
  /** Значимые кандидаты для диагностики parse-probe */
  nonWalletCandidateValues: Record<string, number | null>;
};

function toRub(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Единая цепочка кандидатов «цена без WB Кошелька, с СПП» (DOM / buyer / orchestrator).
 * Popup «Детализация цены» не используется как источник nonWalletRub (см. finalizeRepricerPriceSemantics).
 *
 * Финальный шаг (после основных источников): если nonWalletRub всё ещё не найден,
 * но `cardApiShowcaseRub > walletRub` — принимаем `cardApiShowcaseRub` как цену с СПП без кошелька.
 */
export function resolveNonWalletRubDetailed(
  base: WalletParserResult,
  orc: ShowcaseOrchestratorResult | null,
  walletLineForCross: number | null,
): NonWalletRubDetail {
  const wl = walletLineForCross;

  const sppDom = toRub(base.priceWithSppWithoutWalletRub);
  const bpvPw = toRub(base.buyerPriceVerification?.priceWithoutWallet);

  const candidateValues: Record<string, number | null> = {
    priceWithSppWithoutWalletRub: sppDom,
    buyerPriceVerification_priceWithoutWallet: bpvPw,
    cardApiShowcaseRub: toRub(base.cardApiShowcaseRub),
    showcaseRubFromCardApi: toRub(base.showcaseRubFromCardApi),
    cardApiWalletRub: toRub(base.cardApiWalletRub),
    apiWalletRub: toRub(base.apiWalletRub),
    walletRub: toRub(base.walletRub),
    walletLineForCross: wl,
    verifiedLocalWithoutWalletRub: toRub(orc?.verifiedLocalWithoutWalletRub),
    parser_nonWalletRub_field: toRub(base.nonWalletRub),
  };

  type TryRow = { rub: number; ev: string; src: string };

  const tries: TryRow[] = [];

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

  const parsedField = toRub(base.nonWalletRub);
  if (parsedField != null) {
    tries.push({
      rub: parsedField,
      ev: "parser_non_wallet_field",
      src: "nonWalletRub (DOM/buildWalletResult)",
    });
  }

  const primary = tries[0];

  if (primary != null) {
    return {
      nonWalletRub: primary.rub,
      nonWalletEvidence: primary.ev,
      nonWalletSource: primary.src,
      nonWalletFallbackUsed: false,
      nonWalletCandidateValues: candidateValues,
    };
  }

  const cardApi = toRub(base.cardApiShowcaseRub);
  const walletRubOnly = toRub(base.walletRub);
  if (cardApi != null && walletRubOnly != null && cardApi > walletRubOnly) {
    return {
      nonWalletRub: cardApi,
      nonWalletEvidence: "card_api_showcase_fallback",
      nonWalletSource: "cardApiShowcaseRub",
      nonWalletFallbackUsed: true,
      nonWalletCandidateValues: candidateValues,
    };
  }

  return {
    nonWalletRub: null,
    nonWalletEvidence: null,
    nonWalletSource: null,
    nonWalletFallbackUsed: false,
    nonWalletCandidateValues: candidateValues,
  };
}
