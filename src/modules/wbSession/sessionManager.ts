/**
 * Seller API метаданные + реэкспорт buyer storage / валидации.
 * Канонический buyer auth: `buyerSessionManager` (persistent profile).
 */
import fs from "node:fs";
import axios from "axios";
import { env } from "../../config/env.js";
import { WB_ENDPOINTS } from "../../config/wbEndpoints.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { validateSellerToken } from "../wbSellerApi/client.js";
import {
  getValidCookies as getValidCookiesFromBuyerManager,
  refreshBuyerSessionIfNeeded,
} from "../buyerSession/buyerSessionManager.js";
import {
  resolveBuyerProfileDirAbs,
  resolveStorageStatePathAbs,
  type StorageStateShape,
} from "../buyerSession/buyerStorageIo.js";

const TAG = "wb-session";

export type { StorageStateShape };
export {
  exportCookieHeader,
  loadSavedSession,
  normalizeCookies,
  saveSession,
} from "../buyerSession/buyerStorageIo.js";

/** @deprecated Используйте buyerSessionManager.getCookieHeaderForPipeline; оставлено для совместимости импортов. */
export async function getValidCookies(): Promise<{
  header: string | null;
  from: "file" | "none";
  validated: boolean;
}> {
  return getValidCookiesFromBuyerManager();
}

/**
 * Быстрая проверка cookie header (главная WB). Не заменяет полный buyer probe.
 */
export async function isBrowserCookieSessionAlive(cookieHeader: string | null): Promise<boolean> {
  if (!cookieHeader?.trim()) {
    return false;
  }
  try {
    const res = await axios.get(WB_ENDPOINTS.showcaseOrigin + "/", {
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      timeout: 20_000,
      maxRedirects: 5,
      validateStatus: (status: number) => status >= 200 && status < 400,
    });
    const body = typeof res.data === "string" ? res.data : "";
    const finalUrl = String(res.config?.url ?? "");
    if (
      /security\/login|passport\.wildberries/i.test(finalUrl) ||
      /войти\s+по\s+коду|вход\s+или\s+регистрация/i.test(body)
    ) {
      return false;
    }
    return res.status === 200;
  } catch (e) {
    logger.warn({ tag: TAG, err: e instanceof Error ? e.message : String(e) }, "probe browser session failed");
    return false;
  }
}

export async function isSellerApiSessionAlive(token: string): Promise<boolean> {
  try {
    await validateSellerToken(token);
    return true;
  } catch {
    return false;
  }
}

async function upsertAuthRowSeller(
  kind: string,
  patch: {
    status: string;
    lastError?: string | null;
    lastValidatedAt?: Date;
    lastRefreshAt?: Date;
    lastCookieExportAt?: Date;
    storageStatePath?: string;
    profileDir?: string;
    metaJson?: string;
  },
): Promise<void> {
  await prisma.authSession.upsert({
    where: { kind },
    create: {
      kind,
      status: patch.status,
      lastError: patch.lastError ?? null,
      lastValidatedAt: patch.lastValidatedAt ?? null,
      lastRefreshAt: patch.lastRefreshAt ?? null,
      lastCookieExportAt: patch.lastCookieExportAt ?? null,
      storageStatePath: patch.storageStatePath ?? resolveStorageStatePathAbs(),
      profileDir: patch.profileDir ?? resolveBuyerProfileDirAbs(),
      metaJson: patch.metaJson ?? null,
    },
    update: {
      status: patch.status,
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch.lastValidatedAt ? { lastValidatedAt: patch.lastValidatedAt } : {}),
      ...(patch.lastRefreshAt ? { lastRefreshAt: patch.lastRefreshAt } : {}),
      ...(patch.lastCookieExportAt ? { lastCookieExportAt: patch.lastCookieExportAt } : {}),
      ...(patch.storageStatePath ? { storageStatePath: patch.storageStatePath } : {}),
      ...(patch.profileDir ? { profileDir: patch.profileDir } : {}),
      ...(patch.metaJson !== undefined ? { metaJson: patch.metaJson } : {}),
    },
  });
}

/**
 * Уровень 2 refresh: делегирование в buyerSessionManager (probe + storageState).
 */
export async function refreshSessionIfNeeded(opts?: { headed?: boolean; force?: boolean }): Promise<{
  ok: boolean;
  message: string;
}> {
  const r = await refreshBuyerSessionIfNeeded(opts);
  return { ok: r.ok, message: r.message };
}

export async function syncSellerApiAuthMeta(token: string | null): Promise<void> {
  const outPath = resolveStorageStatePathAbs();
  const profileDir = resolveBuyerProfileDirAbs();
  if (!token) {
    await upsertAuthRowSeller("seller_api", {
      status: "invalid",
      lastError: "no_token",
      lastValidatedAt: new Date(),
      storageStatePath: outPath,
      profileDir,
    });
    return;
  }
  const ok = await isSellerApiSessionAlive(token);
  await upsertAuthRowSeller("seller_api", {
    status: ok ? "active" : "expired",
    lastError: ok ? null : "token_validation_failed",
    lastValidatedAt: new Date(),
    storageStatePath: outPath,
    profileDir,
    metaJson: JSON.stringify({ tokenConfigured: true }),
  });
}

export async function getSessionStatusOverview(): Promise<{
  sellerApi: { status: string; lastValidatedAt: string | null; lastError: string | null };
  buyerBrowser: {
    status: string;
    profileDir: string;
    storageStatePath: string;
    cookieFileExists: boolean;
    lastRefreshAt: string | null;
    lastProbeOk: boolean;
    lastProbeReason: string | null;
  };
}> {
  const profileDir = resolveBuyerProfileDirAbs();
  const storageStatePath = resolveStorageStatePathAbs();
  const cookieFileExists = fs.existsSync(storageStatePath);
  const [sellerRow, buyerRow, buyerSessionRow] = await Promise.all([
    prisma.authSession.findUnique({ where: { kind: "seller_api" } }),
    prisma.authSession.findUnique({ where: { kind: "buyer_browser" } }),
    prisma.buyerSession.findFirst({ orderBy: { updatedAt: "desc" } }),
  ]);
  return {
    sellerApi: {
      status: sellerRow?.status ?? "unknown",
      lastValidatedAt: sellerRow?.lastValidatedAt?.toISOString() ?? null,
      lastError: sellerRow?.lastError ?? null,
    },
    buyerBrowser: {
      status: buyerSessionRow?.status ?? buyerRow?.status ?? "unknown",
      profileDir,
      storageStatePath,
      cookieFileExists,
      lastRefreshAt: buyerRow?.lastRefreshAt?.toISOString() ?? null,
      lastProbeOk: buyerSessionRow?.lastProbeOk ?? false,
      lastProbeReason: buyerSessionRow?.lastProbeReason ?? buyerRow?.lastError ?? null,
    },
  };
}
