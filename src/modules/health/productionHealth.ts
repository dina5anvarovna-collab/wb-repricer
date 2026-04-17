import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { validateSellerToken } from "../wbSellerApi/client.js";
import { decryptToken } from "../../lib/crypto/tokenVault.js";
import { healthBrowser } from "./healthChecks.js";

export async function healthPublicParse(): Promise<{
  ok: boolean;
  lastMonitorJobStatus: string | null;
  lastMonitorFinishedAt: string | null;
  parseStats: Record<string, unknown> | null;
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
  return {
    ok: row?.status === "done",
    lastMonitorJobStatus: row?.status ?? null,
    lastMonitorFinishedAt: row?.finishedAt?.toISOString() ?? null,
    parseStats,
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

export async function buildProductionHealthSummary(): Promise<{
  sellerApi: Awaited<ReturnType<typeof healthSellerApiSummary>>;
  publicParse: Awaited<ReturnType<typeof healthPublicParse>>;
  enforcement: Awaited<ReturnType<typeof healthEnforcement>>;
  browser: Awaited<ReturnType<typeof healthBrowser>>;
  safeModeHoldCount: number;
  ts: string;
}> {
  const [sellerApi, publicParse, enforcement, browser, safeModeHoldCount] = await Promise.all([
    healthSellerApiSummary(),
    healthPublicParse(),
    healthEnforcement(),
    healthBrowser(),
    prisma.wbProduct.count({ where: { safeModeHold: true } }),
  ]);
  return {
    sellerApi,
    publicParse,
    enforcement,
    browser,
    safeModeHoldCount,
    ts: new Date().toISOString(),
  };
}
