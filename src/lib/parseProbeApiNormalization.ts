import {
  resolveNonWalletRubDetailed,
  type NonWalletRubDetail,
} from "./nonWalletRubResolution.js";
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
  nonWalletEvidence: string | null;
  nonWalletSource: string | null;
  walletConfirmed: boolean;
  /** Итоговый primary evidence (см. pickPrimary в finalize) */
  walletEvidence: WalletEvidenceKind;
  /** Все сработавшие признаки, без потери приоритета */
  walletEvidenceLayers: WalletEvidenceKind[];
  verificationMethod: string | null;
  verificationStatus: string | null;
  verificationReason: string | null;
  /** Сырьё для отладки: не затирает `walletEvidence`, а фиксирует уровни */
  walletEvidenceRaw: {
    parserWalletEvidence: WalletEvidenceKind;
    verificationMethod: string | null;
    verificationStatus: string | null;
    verificationReason: string | null;
  };
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

  const walletLine = toRub(r.walletRub) ?? toRub(r.priceWallet) ?? showcaseRub;
  const nwComputed: NonWalletRubDetail = resolveNonWalletRubDetailed(r, null, walletLine);
  const nonWalletRub = r.nonWalletRub ?? nwComputed.nonWalletRub;
  const nonWalletEvidence = r.nonWalletEvidence ?? nwComputed.nonWalletEvidence;
  const nonWalletSource = r.nonWalletSource ?? nwComputed.nonWalletSource;

  const hasWalletLabel = typeof r.walletLabel === "string" && r.walletLabel.trim().length > 0;
  const domWalletMethod = r.verificationMethod === "dom_wallet";

  const walletConfirmed =
    typeof r.walletConfirmed === "boolean"
      ? r.walletConfirmed
      : r.verificationStatus === "VERIFIED" ||
        hasWalletLabel ||
        r.walletIconDetected === true ||
        domWalletMethod;

  /** Сырой evidence с поля парсера (до API-фолбэков) */
  const parserWalletEvidenceRaw: WalletEvidenceKind = r.walletEvidence ?? null;
  /** Итоговый evidence: finalize + при необходимости фолбэк */
  let walletEvidence: WalletEvidenceKind = parserWalletEvidenceRaw;

  const rawPayload = {
    parserWalletEvidence: parserWalletEvidenceRaw,
    verificationMethod: typeof r.verificationMethod === "string" ? r.verificationMethod : null,
    verificationStatus: typeof r.verificationStatus === "string" ? r.verificationStatus : null,
    verificationReason: typeof r.verificationReason === "string" ? r.verificationReason : null,
  };

  if (walletEvidence == null) {
    if (
      r.verificationStatus === "VERIFIED" &&
      r.verificationMethod === "dom_wallet" &&
      toRub(r.priceWallet) != null
    ) {
      walletEvidence = "dom_wallet";
    } else if (bpv?.verificationStatus === "VERIFIED" && bpv.verificationMethod === "dom_wallet") {
      walletEvidence = "dom_wallet";
    } else if (domWalletMethod) {
      walletEvidence = "dom_wallet";
    } else if (hasWalletLabel) {
      walletEvidence = "wallet_label";
    } else if (r.walletIconDetected === true) {
      walletEvidence = "wallet_marker";
    } else if (r.verificationStatus === "VERIFIED") {
      walletEvidence = "dom_wallet";
    }
  }

  const verificationMethod =
    typeof r.verificationMethod === "string"
      ? r.verificationMethod
      : typeof bpv?.verificationMethod === "string"
        ? bpv.verificationMethod
        : null;
  const verificationStatus =
    typeof r.verificationStatus === "string"
      ? r.verificationStatus
      : typeof bpv?.verificationStatus === "string"
        ? bpv.verificationStatus
        : null;
  const verificationReason =
    typeof r.verificationReason === "string"
      ? r.verificationReason
      : typeof bpv?.verificationReason === "string"
        ? bpv.verificationReason
        : null;

  return {
    priceRegular,
    showcaseRub,
    walletRub,
    nonWalletRub,
    nonWalletEvidence,
    nonWalletSource,
    walletConfirmed,
    walletEvidence,
    walletEvidenceLayers: r.walletEvidenceLayers ?? [],
    verificationMethod,
    verificationStatus,
    verificationReason,
    walletEvidenceRaw: rawPayload,
  };
}

/** Диагностика для POST /api/settings/parse-probe-* (источники non-wallet / кошелёк, сырьё SPP). */
export function buildParseProbeDiagnostics(r: WalletParserResult) {
  return {
    nonWalletSourceUsed: r.nonWalletSource ?? null,
    nonWalletFallbackUsed: r.nonWalletFallbackUsed === true,
    nonWalletCandidateValues: r.nonWalletCandidateValues ?? {},
    walletSourceUsed: r.walletEvidence ?? null,
    priceWithSppWithoutWalletRubRaw: r.priceWithSppWithoutWalletRub ?? null,
    buyerPriceVerificationPriceWithoutWallet: r.buyerPriceVerification?.priceWithoutWallet ?? null,
    sourceConflictDetected: r.sourceConflictDetected === true,
    sourceConflictReason:
      r.sourceConflictDetected === true
        ? (r.showcaseResolutionNote ?? r.verificationReason ?? null)
        : null,
  };
}
