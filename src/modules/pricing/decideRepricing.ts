import type { WalletDecisionSessionStatus, WalletEvidence } from "./walletEvidence.js";

export type RepricingDecisionAction =
  | "enforce_now"
  | "skip_safe_hold"
  | "skip_stale"
  | "skip_conflict"
  | "skip_invalid_session"
  | "skip_out_of_stock";

export type RepricingDecision = {
  action: RepricingDecisionAction;
  status: "enforce" | "safe_hold";
  enforce: boolean;
  reason: string;
};

export function decideRepricing(input: {
  sellerPriceRub: number | null;
  floorRub: number | null;
  walletEvidence: WalletEvidence | null;
  sessionStatus: WalletDecisionSessionStatus;
  stock: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN_STOCK";
  freshness: { isFresh: boolean; ageMinutes: number | null };
}): RepricingDecision {
  if (input.stock === "UNKNOWN_STOCK") {
    return {
      action: "skip_safe_hold",
      status: "safe_hold",
      enforce: false,
      reason: "unknown_stock",
    };
  }
  if (input.stock !== "IN_STOCK") {
    return {
      action: "skip_out_of_stock",
      status: "safe_hold",
      enforce: false,
      reason: "out_of_stock",
    };
  }
  if (input.sessionStatus === "invalid") {
    return {
      action: "skip_invalid_session",
      status: "safe_hold",
      enforce: false,
      reason: "invalid_session",
    };
  }
  if (input.sessionStatus === "stale" || !input.freshness.isFresh) {
    return {
      action: "skip_stale",
      status: "safe_hold",
      enforce: false,
      reason: "stale_data_or_session",
    };
  }
  if (input.walletEvidence?.conflict === true) {
    return {
      action: "skip_conflict",
      status: "safe_hold",
      enforce: false,
      reason: "wallet_source_conflict",
    };
  }
  if (
    !input.walletEvidence ||
    !input.walletEvidence.actionable ||
    input.walletEvidence.walletRub == null ||
    input.walletEvidence.walletRub <= 0
  ) {
    return {
      action: "skip_safe_hold",
      status: "safe_hold",
      enforce: false,
      reason: "wallet_not_actionable",
    };
  }
  return {
    action: "enforce_now",
    status: "enforce",
    enforce: true,
    reason: "wallet_actionable",
  };
}

