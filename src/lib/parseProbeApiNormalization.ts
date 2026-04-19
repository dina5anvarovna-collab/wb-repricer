import type {
  WalletEvidenceKind,
  WalletParserResult,
} from "../walletDom/wbWalletPriceParser.js";

function toRub(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export type ParseProbeNormalizedPrices = {
  priceRegular: number | null;
  showcaseRub: number | null;
  walletRub: number | null;
  nonWalletRub: number | null;
  walletConfirmed: boolean;
  walletEvidence: WalletEvidenceKind;
};

/**
 * Единые правила верхнего уровня для POST /api/settings/parse-probe-browser
 * (без ручного разбора `raw`).
 */
export function normalizeParseProbePriceFields(r: WalletParserResult): ParseProbeNormalizedPrices {
  const bpv = r.buyerPriceVerification;

  const priceRegular = toRub(r.oldPriceRub) ?? toRub(r.priceRegular);

  const showcaseRub =
    toRub(r.showcaseRubFromDom) ??
    toRub(r.showcasePriceRub) ??
    toRub(r.showcaseRub) ??
    toRub(r.showcaseRubEffective) ??
    toRub(r.priceWallet);

  let walletRub: number | null = null;
  if (r.verificationStatus === "VERIFIED" && toRub(r.priceWallet) != null) {
    walletRub = toRub(r.priceWallet);
  }
  if (walletRub == null) {
    walletRub = toRub(r.walletRub);
  }

  const nonWalletRub =
    toRub(r.priceWithSppWithoutWalletRub) ??
    toRub(bpv?.priceWithoutWallet) ??
    toRub(r.nonWalletRub);

  const hasWalletLabel = typeof r.walletLabel === "string" && r.walletLabel.trim().length > 0;
  const domWalletMethod = r.verificationMethod === "dom_wallet";

  const walletConfirmed =
    Boolean(r.walletConfirmed) ||
    r.verificationStatus === "VERIFIED" ||
    hasWalletLabel ||
    r.walletIconDetected === true ||
    domWalletMethod;

  const precise = r.walletEvidence ?? null;
  let walletEvidence: WalletEvidenceKind = null;

  if (precise === "buyer_session" || precise === "showcase_less_than_nonwallet") {
    walletEvidence = precise;
  } else if (
    r.verificationStatus === "VERIFIED" &&
    r.verificationMethod === "dom_wallet" &&
    toRub(r.priceWallet) != null
  ) {
    walletEvidence = "dom_wallet";
  } else if (precise === "wallet_label" || precise === "wallet_marker") {
    walletEvidence = precise;
  } else if (domWalletMethod) {
    walletEvidence = "dom_wallet";
  } else if (hasWalletLabel) {
    walletEvidence = "wallet_label";
  } else if (r.walletIconDetected === true) {
    walletEvidence = "wallet_marker";
  } else if (precise === "dom_wallet") {
    walletEvidence = "dom_wallet";
  } else if (r.verificationStatus === "VERIFIED") {
    walletEvidence = "dom_wallet";
  }

  return {
    priceRegular,
    showcaseRub,
    walletRub,
    nonWalletRub,
    walletConfirmed,
    walletEvidence,
  };
}
