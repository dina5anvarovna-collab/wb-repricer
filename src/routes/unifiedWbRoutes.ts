import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { normalizeWbProductFromDb } from "../modules/wbData/normalizeProduct.js";
import {
  getSessionStatusOverview,
  getValidCookies,
  isBrowserCookieSessionAlive,
  isSellerApiSessionAlive,
  loadSavedSession,
  refreshSessionIfNeeded,
} from "../modules/wbSession/sessionManager.js";
import path from "node:path";
import fs from "node:fs";
import { env } from "../config/env.js";
import {
  getActiveCabinetToken,
  resolveBuyerProfileDir,
} from "../modules/catalogSync/syncCatalog.js";
import { runUnifiedSync } from "../modules/wbSync/unifiedSyncService.js";
import { syncSellerApiAuthMeta } from "../modules/wbSession/sessionManager.js";
import {
  headedBrowserLoginBlockedMessage,
  headedBrowserLoginEnvironmentOk,
} from "../modules/buyerSession/buyerSessionManager.js";
import { isBuyerAuthDisabled, isPublicOnlyWalletParse } from "../lib/repricerMode.js";
import {
  buildUnifiedObservation,
  buildSellerSideFromWbProduct,
  buildBuyerSideFromWbProductCache,
} from "../lib/unifiedPriceModel.js";

function parseLimit(raw: string | undefined, def: number, cap: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), cap);
}

export function registerUnifiedWbRoutes(app: FastifyInstance): void {
  app.get("/api/health", async () => ({
    ok: true,
    service: "wb-repricer",
    ts: new Date().toISOString(),
  }));

  app.get("/api/auth/status", async () => {
    const overview = await getSessionStatusOverview();
    const { header } = await getValidCookies();
    const cookieAlive = header ? await isBrowserCookieSessionAlive(header) : false;
    const auth = await getActiveCabinetToken();
    const tokenAlive = auth ? await isSellerApiSessionAlive(auth.token) : false;
    const verifyMode = env.REPRICER_BUYER_VERIFY_MODE.trim().toLowerCase();
    const walletMode = env.REPRICER_WALLET_PARSE_MODE.trim().toLowerCase();
    const publicFirstPolicy =
      verifyMode === "public_first" ||
      walletMode.startsWith("public_then") ||
      walletMode === "public";
    const buyerAuthDisabled = isBuyerAuthDisabled();
    const publicOnly = isPublicOnlyWalletParse();
    const needsBuyerLogin = buyerAuthDisabled
      ? false
      : publicFirstPolicy
        ? false
        : overview.buyerBrowser.cookieFileExists
          ? !cookieAlive
          : true;
    let message: string | null = null;
    const latestSnapshot = await prisma.priceSnapshot.findFirst({
      orderBy: { parsedAt: "desc" },
      select: { walletParseStatus: true, detailJson: true },
    });
    let statusHint: "CAPTCHA_HOLD" | "STALE_SESSION" | "USING_LAST_GOOD" | "OK" = "OK";
    let detail: Record<string, unknown> = {};
    if (latestSnapshot?.detailJson) {
      try {
        detail = JSON.parse(latestSnapshot.detailJson) as Record<string, unknown>;
      } catch {
        detail = {};
      }
    }
    const parseStatus = latestSnapshot?.walletParseStatus ?? null;
    if (parseStatus === "blocked_or_captcha" || parseStatus === "captcha") {
      statusHint = "CAPTCHA_HOLD";
    } else if (parseStatus === "auth_required" || detail.sessionStatus === "stale") {
      statusHint = "STALE_SESSION";
    } else if (detail.usedLastGoodFallback === true || detail.safeMode === true) {
      statusHint = "USING_LAST_GOOD";
    }
    if (!tokenAlive && auth) {
      message = "Сессия Seller API (токен) отклонена WB — обновите токен в «Подключение WB».";
    } else if (buyerAuthDisabled) {
      message = publicOnly
        ? "Режим только публичного парсинга (REPRICER_DISABLE_BUYER_AUTH): витрина и popup без buyer-login и cookies."
        : null;
    } else if (!cookieAlive && !publicFirstPolicy) {
      message =
        "Сессия браузера (витрина) не подтверждена — «Обновить авторизацию» или вход через CLI.";
    } else if (!cookieAlive && publicFirstPolicy) {
      message =
        "Public-first: мониторинг сначала парсит витрину/popup без обязательного buyer-login. Cookies нужны только как fallback (импорт storageState / профиль).";
    }
    return {
      ...overview,
      checks: {
        sellerTokenAlive: tokenAlive,
        buyerCookieProbe: cookieAlive,
        hasCookieFile: overview.buyerBrowser.cookieFileExists,
      },
      parsePolicy: {
        publicFirst: publicFirstPolicy,
        walletParseMode: env.REPRICER_WALLET_PARSE_MODE,
        buyerVerifyMode: env.REPRICER_BUYER_VERIFY_MODE.trim() || "strict",
      },
      publicParsing: {
        buyerAuthDisabled,
        publicOnly,
        walletParseMode: env.REPRICER_WALLET_PARSE_MODE.trim(),
        walletDetailsMode: env.REPRICER_WALLET_DETAILS_MODE.trim() || "popup_first",
        monitorSppViaCookies:
          buyerAuthDisabled
            ? false
            : !["0", "false", "no", "off"].includes(env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase()),
      },
      needsBuyerLogin,
      statusHint,
      message,
    };
  });

  app.post("/api/auth/check", async () => {
    const auth = await getActiveCabinetToken();
    await syncSellerApiAuthMeta(auth?.token ?? null);
    const { header } = await getValidCookies();
    const cookieOk = header ? await isBrowserCookieSessionAlive(header) : false;
    const tokenOk = auth ? await isSellerApiSessionAlive(auth.token) : false;
    return {
      ok: isBuyerAuthDisabled() ? tokenOk : tokenOk || cookieOk,
      sellerTokenOk: tokenOk,
      buyerCookieOk: cookieOk,
    };
  });

  app.post<{ Body: { headed?: boolean } }>("/api/auth/refresh", async (req, reply) => {
    if (isBuyerAuthDisabled()) {
      return reply.code(410).send({
        ok: false,
        message: "Buyer cookies refresh disabled (REPRICER_DISABLE_BUYER_AUTH).",
        code: "buyer_auth_disabled",
      });
    }
    const headed = req.body?.headed === true;
    const r = await refreshSessionIfNeeded({ headed, force: true });
    return { ok: r.ok, message: r.message };
  });

  app.post("/api/auth/login/start", async (req, reply) => {
    if (isBuyerAuthDisabled()) {
      return reply.code(410).send({
        ok: false,
        message: "Buyer CLI login disabled (REPRICER_DISABLE_BUYER_AUTH). Use public parsing only.",
        code: "buyer_auth_disabled",
      });
    }
    const profileDir = resolveBuyerProfileDir();
    const projectRoot = path.isAbsolute(env.REPRICER_WALLET_PROJECT_ROOT)
      ? env.REPRICER_WALLET_PROJECT_ROOT
      : path.resolve(process.cwd(), env.REPRICER_WALLET_PROJECT_ROOT);
    const cliRel = env.REPRICER_WALLET_CLI_PATH;
    const cliPath = path.isAbsolute(cliRel) ? cliRel : path.resolve(process.cwd(), cliRel);
    const browser =
      process.env.REPRICER_DOM_BROWSER?.trim().toLowerCase() === "chrome" ? "chrome" : "chromium";
    const nodeBin = process.execPath;
    const cmd = `cd "${projectRoot}" && "${nodeBin}" "${cliPath}" --login=true --headless=false --userDataDir="${profileDir}" --browser=${browser}`;
    const headedOk = headedBrowserLoginEnvironmentOk();
    return {
      ok: true,
      mode: "headed_cli",
      instruction: headedOk
        ? "Сессия истекла, требуется повторный вход в WB. Выполните команду в терминале на машине с сервером или нажмите «Обновить cookies» (фоновый браузер)."
        : "Интерактивное окно на этой машине недоступно. Используйте импорт storageState / архива профиля с ПК или headless-обновление кук.",
      profileDir,
      cliCommand: cmd,
      cliExists: fs.existsSync(cliPath),
      headedLoginAvailable: headedOk,
      headedLoginNote: headedOk ? null : headedBrowserLoginBlockedMessage(),
      alternative: "POST /api/auth/refresh с {\"headed\":true} — откроется окно браузера с профилем (если сервер с GUI).",
    };
  });

  app.get("/api/products", async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = parseLimit(q.limit, 100, 500);
    const offset = Math.max(0, parseInt(q.offset ?? "0", 10) || 0);
    const rows = await prisma.wbProduct.findMany({
      where: { isActive: true },
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
    });
    const total = await prisma.wbProduct.count({ where: { isActive: true } });
    const items = rows.map((p) => normalizeWbProductFromDb(p));
    return { total, limit, offset, items };
  });

  /** Один товар в нормализованном виде: GET /api/products/:id?view=normalized (id = nmId или cuid) — см. registerApiRoutes */

  app.get("/api/stocks", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseLimit(q.limit, 200, 2000);
    const rows = await prisma.wbProduct.findMany({
      where: { isActive: true },
      take: limit,
      orderBy: { nmId: "asc" },
      select: {
        nmId: true,
        title: true,
        vendorCode: true,
        stock: true,
        brand: true,
        updatedAt: true,
      },
    });
    return {
      items: rows.map((r) => ({
        nmId: r.nmId,
        title: r.title,
        vendorCode: r.vendorCode,
        brand: r.brand,
        stocksTotal: r.stock ?? 0,
        stocksByWarehouse: [
          { warehouseId: "total", warehouseName: "Всего (кабинет)", quantity: r.stock ?? 0 },
        ],
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.get("/api/prices", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseLimit(q.limit, 200, 2000);
    const rows = await prisma.wbProduct.findMany({
      where: { isActive: true },
      take: limit,
      orderBy: { nmId: "asc" },
      select: {
        nmId: true,
        title: true,
        sellerPrice: true,
        sellerDiscount: true,
        discountedPriceRub: true,
        lastWalletObservedRub: true,
        lastRegularObservedRub: true,
        lastKnownShowcaseRub: true,
        lastKnownWalletRub: true,
        lastPriceRegularObservedRub: true,
        updatedAt: true,
      },
    });
    return {
      items: rows.map((r) => ({
        nmId: r.nmId,
        title: r.title,
        price: r.sellerPrice,
        discountedPrice: r.discountedPriceRub,
        sellerPriceRub: r.sellerPrice,
        sellerDiscountPct: r.sellerDiscount,
        sellerDiscountPriceRub: r.discountedPriceRub,
        sellerDiscountPercent: r.sellerDiscount,
        lastBuyerWalletRub: r.lastWalletObservedRub,
        lastBuyerRegularRub: r.lastRegularObservedRub,
        unified: buildUnifiedObservation(buildSellerSideFromWbProduct(r), buildBuyerSideFromWbProductCache(r)),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.get("/api/discounts", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseLimit(q.limit, 200, 2000);
    const rows = await prisma.wbProduct.findMany({
      where: { isActive: true },
      take: limit,
      orderBy: { nmId: "asc" },
      select: {
        nmId: true,
        title: true,
        sellerPrice: true,
        discountedPriceRub: true,
        sellerDiscount: true,
        lastWalletObservedRub: true,
        lastRegularObservedRub: true,
        lastKnownShowcaseRub: true,
        lastKnownWalletRub: true,
        lastPriceRegularObservedRub: true,
        updatedAt: true,
      },
    });
    return {
      items: rows.map((r) => ({
        nmId: r.nmId,
        title: r.title,
        basePrice: r.sellerPrice,
        discountedPrice: r.discountedPriceRub,
        sellerPriceRub: r.sellerPrice,
        sellerDiscountPct: r.sellerDiscount,
        sellerDiscountPriceRub: r.discountedPriceRub,
        discountPercent: r.sellerDiscount,
        unified: buildUnifiedObservation(buildSellerSideFromWbProduct(r), buildBuyerSideFromWbProductCache(r)),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/api/sync/all", async () => runUnifiedSync("all"));
  app.post("/api/sync/stocks", async () => runUnifiedSync("stocks"));
  app.post("/api/sync/prices", async () => runUnifiedSync("prices"));

  app.get("/api/logs", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseLimit(q.limit, 50, 200);
    const rows = await prisma.syncRunLog.findMany({
      take: limit,
      orderBy: { startedAt: "desc" },
    });
    return { items: rows };
  });

  /** Экспорт storageState JSON (без отдачи в публичный интернет в production — только под вашим admin auth) */
  app.get("/api/auth/storage-state/meta", async () => {
    const st = await loadSavedSession();
    return {
      cookieCount: st?.cookies?.length ?? 0,
      hasFile: Boolean(st),
    };
  });

  logger.info("unified WB routes registered (/api/auth/*, /api/products, /api/sync/*, …)");
}
