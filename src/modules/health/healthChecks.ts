import fs from "node:fs";
import { chromium } from "playwright";
import { prisma } from "../../lib/prisma.js";
import { runtimePaths } from "../../lib/runtimePaths.js";
import { loadSavedSession } from "../buyerSession/buyerStorageIo.js";
import { env } from "../../config/env.js";
import { isBuyerAuthDisabled } from "../../lib/repricerMode.js";

function envTruthy(v: string): boolean {
  const t = v.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(t);
}

export async function healthDb(): Promise<{ ok: boolean; error?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function healthBrowser(): Promise<{
  ok: boolean;
  executable: string | null;
  headless: boolean;
  error?: string;
}> {
  const executable = env.BROWSER_EXECUTABLE_PATH.trim() || null;
  const headless = envTruthy(env.HEADLESS);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    const launchPromise = chromium.launch({
      headless,
      ...(executable ? { executablePath: executable } : {}),
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    browser = await Promise.race([
      launchPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("browser launch timeout")), 8_000)),
    ]);
    await browser.close();
    return { ok: true, executable, headless };
  } catch (e) {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    return {
      ok: false,
      executable,
      headless,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function healthBuyerSession(): Promise<{
  ok: boolean;
  buyerReady: boolean;
  active: boolean;
  hasSavedState: boolean;
  profileDir: string;
  statePath: string;
  lastValidatedAt: string | null;
  validation: "fresh" | "stale" | "missing";
  reason?: string;
}> {
  if (isBuyerAuthDisabled()) {
    return {
      ok: true,
      buyerReady: true,
      active: false,
      hasSavedState: false,
      profileDir: runtimePaths.buyerProfileDir,
      statePath: runtimePaths.buyerStatePath,
      lastValidatedAt: null,
      validation: "missing",
      reason: "public_only_buyer_auth_disabled",
    };
  }
  const buyer = await prisma.buyerSession.findFirst({
    where: { isAuthorized: true, status: "fresh" },
    orderBy: { updatedAt: "desc" },
  });
  const savedState = await loadSavedSession();
  const hasSavedState = Boolean(savedState?.cookies?.length);
  const lastValidatedAt = buyer?.lastValidatedAt ?? null;
  let hasDomAccess = false;
  let hasCookieAccess = false;
  if (buyer?.notes) {
    try {
      const parsed = JSON.parse(buyer.notes) as Record<string, unknown>;
      hasDomAccess = parsed.hasDomAccess === true;
      hasCookieAccess = parsed.hasCookieAccess === true;
    } catch {
      // ignore malformed notes
    }
  }
  const ttlMs = env.REPRICER_BUYER_SESSION_TTL_MIN * 60 * 1000;
  const fresh =
    buyer?.lastProbeOk === true &&
    hasDomAccess &&
    hasCookieAccess &&
    buyer.lastValidatedAt != null &&
    Date.now() - buyer.lastValidatedAt.getTime() <= ttlMs;
  const validation = buyer == null ? "missing" : fresh ? "fresh" : "stale";
  return {
    /** Сервис в целом здоров; buyer — опциональный fallback, а не обязательный. */
    ok: true,
    buyerReady: Boolean(buyer && hasSavedState) && validation === "fresh",
    active: Boolean(buyer),
    hasSavedState,
    profileDir: runtimePaths.buyerProfileDir,
    statePath: runtimePaths.buyerStatePath,
    lastValidatedAt: lastValidatedAt ? lastValidatedAt.toISOString() : null,
    validation,
    reason:
      validation === "fresh"
        ? undefined
        : validation === "missing"
          ? "buyer_session_missing"
          : "buyer_session_not_fresh_or_missing_cookie_state",
  };
}

export function healthStorageDirs(): { ok: boolean; dirs: Record<string, boolean> } {
  const dirs = {
    data: fs.existsSync(runtimePaths.dataDir),
    logs: fs.existsSync(runtimePaths.logDir),
    tmp: fs.existsSync(runtimePaths.tmpDir),
    storage: fs.existsSync(runtimePaths.storageDir),
    buyerProfile: fs.existsSync(runtimePaths.buyerProfileDir),
  };
  return { ok: Object.values(dirs).every(Boolean), dirs };
}
