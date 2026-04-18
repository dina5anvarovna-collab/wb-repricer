import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { validateSellerToken } from "../wbSellerApi/client.js";
import { decryptToken } from "../../lib/crypto/tokenVault.js";
import { healthBrowser } from "./healthChecks.js";
import {
  buildPublicProxyFromEnv,
  envPublicParseDebugEnabled,
  resolvePublicBrowserHeadless,
} from "../../lib/publicBrowserRuntime.js";
import { getLastPublicParseProbe } from "../../lib/publicParseProbeState.js";
import { getLastBrowserParseProbe } from "../../lib/browserParseProbeState.js";

export async function healthPublicParse(): Promise<{
  ok: boolean;
  lastMonitorJobStatus: string | null;
  lastMonitorFinishedAt: string | null;
  parseStats: Record<string, unknown> | null;
  /** Режим headless для REPRICER_PUBLIC_BROWSER_* (эффективное значение после fallback). */
  publicBrowserHeadless: boolean;
  publicBrowserHeadedFallback: boolean;
  publicProxyEnabled: boolean;
  publicParseDebugEnabled: boolean;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastParseStatus: string | null;
  lastBlockReason: string | null;
  lastProbeSuccessAt: string | null;
}> {
  const row = await prisma.syncJob.findFirst({
    where: { type: "monitor" },
    orderBy: { startedAt: "desc" },
  });
  let parseStats: Record<string, unknown> | null = null;
  if (row?.meta) {
    try {
      parseStats = (JSON.parse(row.meta) as { parseStats?: Record<string, unknown> }).parseStats ?? null;
    } catch {
      parseStats = null;
    }
  }

  const hl = resolvePublicBrowserHeadless(undefined);
  const proxy = buildPublicProxyFromEnv();
  const probe = getLastPublicParseProbe();

  return {
    ok: row?.status === "done",
    lastMonitorJobStatus: row?.status ?? null,
    lastMonitorFinishedAt: row?.finishedAt?.toISOString() ?? null,
    parseStats,
    publicBrowserHeadless: hl.headless,
    publicBrowserHeadedFallback: hl.headedFallback,
    publicProxyEnabled: Boolean(proxy?.server),
    publicParseDebugEnabled: envPublicParseDebugEnabled(),
    lastProbeAt: probe?.at ?? null,
    lastProbeOk: probe?.ok ?? null,
    lastParseStatus: probe?.parseStatus ?? null,
    lastBlockReason: probe?.blockReason ?? null,
    lastProbeSuccessAt: probe?.ok === true ? probe.at : null,
  };
}

export async function healthBrowserParse(): Promise<{
  ok: boolean;
  lastMonitorJobStatus: string | null;
  lastMonitorFinishedAt: string | null;
  parseStats: Record<string, unknown> | null;
  recoveryStats: Record<string, unknown> | null;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastParseStatus: string | null;
  lastBlockReason: string | null;
  lastContour: string | null;
}> {
  const row = await prisma.syncJob.findFirst({
    where: { type: "monitor" },
    orderBy: { startedAt: "desc" },
  });
  let parseStats: Record<string, unknown> | null = null;
  let recoveryStats: Record<string, unknown> | null = null;
  if (row?.meta) {
    try {
      const m = JSON.parse(row.meta) as {
        parseStats?: Record<string, unknown>;
        recoveryStats?: Record<string, unknown>;
      };
      parseStats = m.parseStats ?? null;
      recoveryStats = (m.recoveryStats as Record<string, unknown>) ?? null;
    } catch {
      parseStats = null;
      recoveryStats = null;
    }
  }
  const probe = getLastBrowserParseProbe();
  return {
    ok: row?.status === "done",
    lastMonitorJobStatus: row?.status ?? null,
    lastMonitorFinishedAt: row?.finishedAt?.toISOString() ?? null,
    parseStats,
    recoveryStats,
    lastProbeAt: probe?.at ?? null,
    lastProbeOk: probe?.ok ?? null,
    lastParseStatus: probe?.parseStatus ?? null,
    lastBlockReason: probe?.blockReason ?? null,
    lastContour: probe?.monitorParseContour ?? null,
  };
}

export async function healthEnforcement(): Promise<{
  ok: boolean;
  lastJobStatus: string | null;
  lastFinishedAt: string | null;
}> {
  const row = await prisma.syncJob.findFirst({
    where: { type: "enforce" },
    orderBy: { startedAt: "desc" },
  });
  return {
    ok: row?.status === "done",
    lastJobStatus: row?.status ?? null,
    lastFinishedAt: row?.finishedAt?.toISOString() ?? null,
  };
}

export async function healthSellerApiSummary(): Promise<{
  configured: boolean;
  tokenValid: boolean | null;
}> {
  const cabinet = await prisma.sellerCabinet.findFirst({ where: { isActive: true } });
  if (!cabinet?.tokenEncrypted) {
    return { configured: false, tokenValid: null };
  }
  try {
    const t = decryptToken(cabinet.tokenEncrypted, env.REPRICER_MASTER_SECRET);
    await validateSellerToken(t);
    return { configured: true, tokenValid: true };
  } catch {
    return { configured: true, tokenValid: false };
  }
}

export type RiskBucketSummary = {
  captcha: number;
  authWall: number;
  blocked: number;
  safeHold: number;
  belowMin: number;
  parseFailed: number;
  staleLastGood: number;
  needsReview: number;
};

export async function computeRiskBucketSummary(): Promise<RiskBucketSummary> {
  const [
    belowMin,
    parseFailed,
    needsReview,
    safeHold,
    staleLastGood,
    authProblem,
  ] = await Promise.all([
    prisma.wbProduct.count({ where: { lastEvaluationStatus: "below_min" } }),
    prisma.wbProduct.count({ where: { lastEvaluationStatus: "parse_failed" } }),
    prisma.wbProduct.count({ where: { lastEvaluationStatus: "needs_review" } }),
    prisma.wbProduct.count({ where: { safeModeHold: true } }),
    prisma.wbProduct.count({
      where: {
        OR: [
          { lastEvaluationStatus: "last_good_used" },
          { lastEvaluationStatus: "wallet_source_unavailable_safe_hold" },
        ],
      },
    }),
    prisma.wbProduct.count({ where: { lastEvaluationStatus: "auth_problem" } }),
  ]);

  const captchaDetailed = await prisma.wbProduct.count({
    where: {
      lastEvaluationStatus: "auth_problem",
      lastWalletParseStatus: "blocked_or_captcha",
    },
  });

  return {
    captcha: captchaDetailed,
    authWall: Math.max(0, authProblem - captchaDetailed),
    blocked: 0,
    safeHold,
    belowMin,
    parseFailed,
    staleLastGood,
    needsReview,
  };
}

export async function buildProductionHealthSummary(): Promise<{
  sellerApi: Awaited<ReturnType<typeof healthSellerApiSummary>>;
  publicParse: Awaited<ReturnType<typeof healthPublicParse>>;
  browserParse: Awaited<ReturnType<typeof healthBrowserParse>>;
  enforcement: Awaited<ReturnType<typeof healthEnforcement>>;
  browser: Awaited<ReturnType<typeof healthBrowser>>;
  safeModeHoldCount: number;
  riskBuckets: RiskBucketSummary;
  lastSuccessfulWalletParseAt: string | null;
  ts: string;
}> {
  const [
    sellerApi,
    publicParse,
    browserParse,
    enforcement,
    browser,
    safeModeHoldCount,
    riskBuckets,
    lastSnap,
  ] = await Promise.all([
    healthSellerApiSummary(),
    healthPublicParse(),
    healthBrowserParse(),
    healthEnforcement(),
    healthBrowser(),
    prisma.wbProduct.count({ where: { safeModeHold: true } }),
    computeRiskBucketSummary(),
    prisma.priceSnapshot.findFirst({
      where: {
        buyerWalletPrice: { gt: 0 },
        walletParseStatus: "wallet_found",
      },
      orderBy: [{ parsedAt: "desc" }, { id: "desc" }],
      select: { parsedAt: true },
    }),
  ]);
  return {
    sellerApi,
    publicParse,
    browserParse,
    enforcement,
    browser,
    safeModeHoldCount,
    riskBuckets,
    lastSuccessfulWalletParseAt: lastSnap?.parsedAt?.toISOString() ?? null,
    ts: new Date().toISOString(),
  };
}
