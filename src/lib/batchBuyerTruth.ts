import type { PriceSnapshot } from "@prisma/client";
import { BUYER_TRUTH_BLOCKERS } from "../modules/pricing/buyerVerificationCrossCheck.js";

const RUB_TOL = 3;

const WEAK_PARSE = new Set([
  "blocked_or_captcha",
  "parse_failed",
  "auth_required",
  "loaded_no_price",
]);

export type BatchBuyerTruthResult = {
  batchVerificationStatus: "VERIFIED" | "UNVERIFIED";
  batchVerificationReason: string;
  effectiveWalletRub: number | null;
};

function parseDetailJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rubSample(s: PriceSnapshot): number | null {
  const w =
    s.walletRub ??
    s.buyerWalletPrice ??
    s.showcaseRub ??
    null;
  if (w == null || !Number.isFinite(w) || w <= 0) return null;
  return Math.round(w);
}

function cardShowcaseFromDetail(dj: Record<string, unknown>): number | null {
  const bpv = dj.buyerPriceVerification;
  if (bpv && typeof bpv === "object") {
    const cs = (bpv as Record<string, unknown>).cardApiShowcaseRub;
    if (typeof cs === "number" && Number.isFinite(cs) && cs > 0) return Math.round(cs);
  }
  const api =
    typeof dj.showcaseApiRub === "number"
      ? dj.showcaseApiRub
      : typeof dj.cardApiRubDebug === "number"
        ? dj.cardApiRubDebug
        : null;
  if (typeof api === "number" && Number.isFinite(api) && api > 0) return Math.round(api);
  return null;
}

function maxSpread(nums: number[]): number {
  if (nums.length <= 1) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[sorted.length - 1]! - sorted[0]!;
}

/**
 * Финальная buyer truth после всех регионов мониторинга:
 * одинаковый wallet по dest, согласованность card API, отсутствие weak-parse и region ambiguity.
 */
export function computeBatchBuyerTruth(input: {
  /** Снимки по каждому выбранному региону (последний на dest), в любом порядке */
  regionSnapshots: PriceSnapshot[];
  /** Число регионов в последнем прогоне монитора (если известно; иначе по числу снимков) */
  monitorRegionCount?: number | null;
}): BatchBuyerTruthResult {
  const snaps = input.regionSnapshots.filter(Boolean);
  if (snaps.length === 0) {
    return {
      batchVerificationStatus: "UNVERIFIED",
      batchVerificationReason: "no_price_snapshots",
      effectiveWalletRub: null,
    };
  }

  const parts: string[] = [];
  let anyWeakParse = false;
  let anyAmbiguous = false;
  const walletSamples: number[] = [];
  const cardShowcases: number[] = [];

  for (const s of snaps) {
    const dj = parseDetailJson(s.detailJson);
    const ps = typeof dj.parseStatus === "string" ? dj.parseStatus : "";
    if (WEAK_PARSE.has(ps)) {
      anyWeakParse = true;
      parts.push(`weak_parse:${ps}`);
    }
    if (dj.regionPriceAmbiguous === true) {
      anyAmbiguous = true;
      parts.push(`ambiguous_dest:${String(s.regionDest ?? "")}`);
    }
    const ws = rubSample(s);
    if (ws != null) walletSamples.push(ws);
    const cs = cardShowcaseFromDetail(dj);
    if (cs != null) cardShowcases.push(cs);
  }

  if (anyWeakParse) {
    return {
      batchVerificationStatus: "UNVERIFIED",
      batchVerificationReason: parts.join(";"),
      effectiveWalletRub: null,
    };
  }
  if (anyAmbiguous) {
    return {
      batchVerificationStatus: "UNVERIFIED",
      batchVerificationReason: parts.join(";") || "region_price_ambiguous",
      effectiveWalletRub: null,
    };
  }

  const uniqWallets = [...new Set(walletSamples)];
  if (uniqWallets.length === 0) {
    return {
      batchVerificationStatus: "UNVERIFIED",
      batchVerificationReason: "no_wallet_observation_across_regions",
      effectiveWalletRub: null,
    };
  }

  if (maxSpread(walletSamples) > RUB_TOL) {
    return {
      batchVerificationStatus: "UNVERIFIED",
      batchVerificationReason: "wallet_mismatch_across_regions",
      effectiveWalletRub: null,
    };
  }

  /** Одно и то же DOM-wallet число при разных cardApi по регионам — не VERIFIED (см. region ambiguity). */
  if (walletSamples.length >= 2 && cardShowcases.length >= 2 && maxSpread(cardShowcases) > RUB_TOL) {
    return {
      batchVerificationStatus: "UNVERIFIED",
      batchVerificationReason: "card_api_showcase_mismatch_same_dom_wallet",
      effectiveWalletRub: null,
    };
  }

  const monitorN = input.monitorRegionCount ?? snaps.length;

  for (const s of snaps) {
    const dj = parseDetailJson(s.detailJson);
    const blocked = Array.isArray(dj.blockedBySafetyRule)
      ? (dj.blockedBySafetyRule as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (blocked.some((b) => BUYER_TRUTH_BLOCKERS.has(b))) {
      parts.push(`blocked:${blocked.filter((b) => BUYER_TRUTH_BLOCKERS.has(b)).join(",")}`);
      return {
        batchVerificationStatus: "UNVERIFIED",
        batchVerificationReason: parts.join(";"),
        effectiveWalletRub: null,
      };
    }
  }

  /** Если мониторят несколько складов — нужен снимок по каждому выбранному dest. */
  if (monitorN > 1 && snaps.length < monitorN) {
    parts.push("incomplete_region_coverage");
    return {
      batchVerificationStatus: "UNVERIFIED",
      batchVerificationReason: parts.join(";"),
      effectiveWalletRub: null,
    };
  }

  const effectiveWalletRub = uniqWallets.length === 1 ? uniqWallets[0]! : Math.min(...uniqWallets);
  return {
    batchVerificationStatus: "VERIFIED",
    batchVerificationReason: "batch_wallet_card_consistent",
    effectiveWalletRub,
  };
}
