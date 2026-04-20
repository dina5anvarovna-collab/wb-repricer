export type WalletEvidenceSource =
  | "dom"
  | "modal"
  | "cookies"
  | "mixed"
  | "unverified";

export type WalletEvidenceParseStatus = "success" | "unsafe";

export type WalletEvidenceLevel = "observed" | "confirmed" | "actionable";

export type WalletDecisionSessionStatus = "fresh" | "stale" | "invalid" | "unknown";

export type WalletEvidence = {
  walletRub: number | null;
  showcaseRub: number | null;
  nonWalletRub: number | null;
  regularRub: number | null;
  source: WalletEvidenceSource;
  sourceConfidence: "high" | "medium" | "low";
  confirmed: boolean;
  parseStatus: WalletEvidenceParseStatus;
  region: string | null;
  nmId: number | null;
  observedAt: string;
  conflict: boolean;
  level: WalletEvidenceLevel;
  actionable: boolean;
};

export function normalizeWalletParseStatus(raw: string | null | undefined): WalletEvidenceParseStatus {
  return raw === "loaded_wallet_confirmed" ? "success" : "unsafe";
}

