import { prisma } from "../lib/prisma.js";
import { decryptToken } from "../lib/crypto/tokenVault.js";
import { env } from "../config/env.js";
import { getAppSetting } from "../lib/appSettings.js";
import {
  getMonitorIntervalHours,
  getPrimaryWalletRegion,
  getSelectedRegionDests,
  setMonitorIntervalHours,
  setSelectedRegionDests,
} from "../lib/monitorPrefs.js";
import {
  getActiveCabinetToken,
  resolveBuyerProfileDir,
} from "../modules/catalogSync/syncCatalog.js";
import { validateSellerToken } from "../modules/wbSellerApi/client.js";

export async function buildSellerStatusPayload() {
  const cabinet = await prisma.sellerCabinet.findFirst({ where: { isActive: true } });
  let tokenOk: boolean | null = null;
  if (cabinet?.tokenEncrypted) {
    try {
      const t = decryptToken(cabinet.tokenEncrypted, env.REPRICER_MASTER_SECRET);
      await validateSellerToken(t);
      tokenOk = true;
    } catch {
      tokenOk = false;
    }
  }
  const buyer = await prisma.buyerSession.findFirst({
    where: { isAuthorized: true, status: "active" },
    orderBy: { updatedAt: "desc" },
  });
  const products = await prisma.wbProduct.count();
  const rules = await prisma.minPriceRule.count({ where: { controlEnabled: true } });
  const paused = await getAppSetting("GLOBAL_PAUSE");
  const estop = await getAppSetting("EMERGENCY_STOP");
  const verifyMode = env.REPRICER_BUYER_VERIFY_MODE.trim().toLowerCase();
  const walletMode = env.REPRICER_WALLET_PARSE_MODE.trim().toLowerCase();
  const publicFirst =
    verifyMode === "public_first" ||
    walletMode.startsWith("public_then") ||
    walletMode === "public";
  return {
    seller: {
      configured: Boolean(cabinet && cabinet.tokenLast4 !== "****"),
      tokenLast4: cabinet?.tokenLast4 ?? null,
      tokenValid: tokenOk,
    },
    buyer: {
      active: Boolean(buyer),
      profileDir: buyer?.profileDir ?? resolveBuyerProfileDir(),
      lastSuccessAt: buyer?.lastSuccessAt?.toISOString() ?? null,
      lastDomSuccessAt: buyer?.lastDomSuccessAt?.toISOString() ?? null,
      status: buyer?.status ?? "invalid",
    },
    catalog: { productCount: products },
    protection: {
      rulesActive: rules,
      globalPause: paused === "true" || paused === "1",
      emergencyStop: estop === "true" || estop === "1",
    },
    parsePolicy: {
      publicFirst,
      walletParseMode: env.REPRICER_WALLET_PARSE_MODE,
      buyerVerifyMode: env.REPRICER_BUYER_VERIFY_MODE.trim() || "strict",
    },
  };
}

export async function buildExtendedDashboardPayload() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const lastMonitor = await prisma.syncJob.findFirst({
    where: { type: "monitor" },
    orderBy: { startedAt: "desc" },
  });
  let lastMonitorParseStats: unknown = null;
  if (lastMonitor?.meta) {
    try {
      const m = JSON.parse(lastMonitor.meta) as { parseStats?: unknown };
      lastMonitorParseStats = m.parseStats ?? null;
    } catch {
      lastMonitorParseStats = null;
    }
  }
  const [
    statusBase,
    belowMin,
    parseFailed,
    needsReview,
    uploadsOk,
    uploadsFail,
    zeroStock,
    lowStock,
    lastCatalogSync,
  ] = await Promise.all([
    buildSellerStatusPayload(),
    prisma.wbProduct.count({ where: { lastEvaluationStatus: "below_min" } }),
    prisma.wbProduct.count({ where: { lastEvaluationStatus: "parse_failed" } }),
    prisma.wbProduct.count({ where: { lastEvaluationStatus: "needs_review" } }),
    prisma.cabinetPriceUpload.count({
      where: { createdAt: { gte: start }, status: "submitted" },
    }),
    prisma.cabinetPriceUpload.count({
      where: { createdAt: { gte: start }, status: "failed" },
    }),
    prisma.wbProduct.count({ where: { isActive: true, OR: [{ stock: 0 }, { stock: null }] } }),
    prisma.wbProduct.count({
      where: { isActive: true, stock: { gt: 0, lt: 5 } },
    }),
    prisma.syncRunLog.findFirst({
      where: { scope: "all", status: "done" },
      orderBy: { finishedAt: "desc" },
    }),
  ]);
  return {
    ...statusBase,
    stats: {
      belowMinCount: belowMin,
      parseFailedCount: parseFailed,
      needsReviewCount: needsReview,
      priceMismatchApproxCount: needsReview + belowMin,
      successfulUploadsToday: uploadsOk,
      failedAttemptsToday: uploadsFail,
      zeroStockCount: zeroStock,
      lowStockCount: lowStock,
      lastCatalogSyncAt: lastCatalogSync?.finishedAt?.toISOString() ?? null,
      lastMonitorAt:
        lastMonitor?.finishedAt?.toISOString() ?? lastMonitor?.startedAt.toISOString() ?? null,
      lastMonitorStatus: lastMonitor?.status ?? null,
      lastMonitorParseStats,
    },
  };
}

export {
  getMonitorIntervalHours,
  getPrimaryWalletRegion,
  getSelectedRegionDests,
  setMonitorIntervalHours,
  setSelectedRegionDests,
  getActiveCabinetToken,
};
