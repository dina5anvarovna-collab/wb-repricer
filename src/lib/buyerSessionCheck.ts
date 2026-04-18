import fs from "node:fs";
import { chromium } from "playwright";
import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { resolveBuyerProfileDir } from "../modules/catalogSync/syncCatalog.js";
import {
  getWbWalletPrice,
  resolveLaunchBrowser,
  type BrowserKind,
} from "../walletDom/wbWalletPriceParser.js";
import { resolveWbBrowserHeadless } from "./wbBrowserEnv.js";
import { resolveWalletDomBrowserKind } from "../modules/wbBuyerDom/runWalletCli.js";
import type { PublicParseBlockReason } from "./publicParseBlockReason.js";

/**
 * Расширенный статус buyer-профиля (проверка реальной карточки + куки).
 * `valid` — можно запускать browser batch с persistent profile.
 */
export type BuyerSessionCheckStatus =
  | "valid"
  | "stale"
  | "invalid"
  | "blocked"
  | "captcha"
  | "auth_wall";

export type BuyerSessionCheckResult = {
  status: BuyerSessionCheckStatus;
  detail?: string;
};

function envWalletProbeEnabled(): boolean {
  const v = env.REPRICER_BUYER_SESSION_WALLET_PROBE.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

function classifyBlockedReason(reason: PublicParseBlockReason | null | undefined): BuyerSessionCheckStatus {
  if (reason === "captcha") return "captcha";
  if (reason === "auth_required") return "auth_wall";
  return "blocked";
}

/**
 * Проверка живой buyer-сессии в persistent-профиле (headless).
 * При включённом REPRICER_BUYER_SESSION_WALLET_PROBE дополнительно парсится nmId карточки — реальная способность увидеть цену кошелька.
 */
export async function checkBuyerSession(
  profileDirOverride?: string,
): Promise<BuyerSessionCheckResult> {
  const profileDir = profileDirOverride ?? resolveBuyerProfileDir();
  if (!fs.existsSync(profileDir)) {
    return { status: "invalid", detail: "profile_dir_missing" };
  }

  try {
    const entries = fs.readdirSync(profileDir);
    if (entries.length === 0) {
      return { status: "invalid", detail: "profile_empty" };
    }
  } catch {
    return { status: "invalid", detail: "profile_read_error" };
  }

  const browserKind: BrowserKind =
    env.BROWSER_EXECUTABLE_PATH.trim()
      ? "chrome"
      : process.platform === "darwin"
        ? "chrome"
        : "chromium";
  const resolved = resolveLaunchBrowser(browserKind);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1366, height: 900 },
    ...(resolved.executablePath ? { executablePath: resolved.executablePath } : {}),
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });

  let cookieAuth = false;
  let domLooksLikeLoginGate = false;
  let domLkHint = false;

  try {
    const page = await ctx.newPage();
    await page.goto("https://www.wildberries.ru/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1200 + Math.floor(Math.random() * 400));

    const cookies = await ctx.cookies();
    const wb = cookies.filter(
      (c) =>
        /wildberries|\.wb\.ru/i.test(c.domain) ||
        c.domain === ".wildberries.ru" ||
        c.domain === "www.wildberries.ru",
    );
    const names = new Set(wb.map((c) => c.name));
    cookieAuth =
      names.has("_wbauid") ||
      names.has("x_wbaas") ||
      names.has("wbx-refresh") ||
      names.has("WBTokenV3") ||
      names.has("wbToken") ||
      names.has("jwt_global") ||
      names.has("__wuid") ||
      wb.length >= 10;

    const dom = await page.evaluate(() => {
      const text = (document.body?.innerText ?? "").slice(0, 12_000);
      const html = document.documentElement?.innerHTML ?? "";
      const looksLikeLoginGate =
        /security\/login|passport\.wildberries/i.test(html) ||
        (/Войти\s+по\s+коду/i.test(text) && !/Мои\s+заказы/i.test(text));
      const lkHint = /\/lk\/|Личный\s+кабинет|Мои\s+заказы/i.test(text);
      const cart =
        Boolean(document.querySelector('a[href*="/lk/basket"]')) ||
        Boolean(document.querySelector('[data-name="menuCart"]')) ||
        Boolean(document.querySelector('[class*="jBasket"]'));
      return { looksLikeLoginGate, lkHint, cart };
    });
    domLooksLikeLoginGate = dom.looksLikeLoginGate;
    domLkHint = dom.lkHint || dom.cart;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ tag: "buyer_session_stale", err: msg }, "buyer session home check failed");
    await ctx.close().catch(() => {});
    return { status: "stale", detail: `check_error:${msg.slice(0, 200)}` };
  } finally {
    await ctx.close().catch(() => {});
  }

  if (!cookieAuth) {
    logger.warn({ tag: "buyer_session_invalid", profileDir, detail: "no_auth_cookies" }, "no auth cookies in profile");
    return { status: "invalid", detail: "no_auth_cookies" };
  }

  if (domLooksLikeLoginGate) {
    logger.warn({ tag: "buyer_session_auth_wall", profileDir }, "login gate on home");
    return { status: "auth_wall", detail: "cookies_but_login_gate" };
  }

  if (!envWalletProbeEnabled()) {
    if (domLkHint) {
      logger.info({ tag: "buyer_session_valid", profileDir, detail: "cookies_and_dom_home_only" }, "buyer session ok (home-only probe)");
      return { status: "valid", detail: "cookies_and_dom_home_only" };
    }
    logger.warn({ tag: "buyer_session_stale", profileDir, detail: "weak_dom_signals" }, "buyer session ambiguous (home-only)");
    return { status: "stale", detail: "weak_dom_signals" };
  }

  try {
    const probeNm = env.REPRICER_BUYER_PROBE_NMID;
    const dest = env.REPRICER_WALLET_DEST.trim() || undefined;
    logger.info({ tag: "buyer_session_wallet_probe_start", profileDir, probeNm }, "wallet price probe on persistent profile");

    const probe = await getWbWalletPrice({
      userDataDir: profileDir,
      nmId: probeNm,
      region: dest,
      headless: resolveWbBrowserHeadless(),
      fetchShowcaseWithCookies: false,
      applyPublicBrowserEnv: false,
      browser: resolveWalletDomBrowserKind(),
    });

    if (
      probe.parseStatus === "wallet_found" ||
      probe.parseStatus === "only_regular_found" ||
      probe.parseStatus === "loaded_showcase_only"
    ) {
      logger.info(
        { tag: "buyer_session_valid", profileDir, detail: "wallet_probe_ok", parseStatus: probe.parseStatus },
        "buyer session valid — wallet probe succeeded",
      );
      return { status: "valid", detail: `wallet_probe_${probe.parseStatus}` };
    }

    if (probe.parseStatus === "blocked_or_captcha") {
      const st = classifyBlockedReason(probe.blockReason ?? null);
      logger.warn(
        { tag: `buyer_session_${st}`, profileDir, blockReason: probe.blockReason },
        "buyer session blocked on wallet probe",
      );
      return {
        status: st,
        detail: probe.blockReason ?? "blocked_or_captcha",
      };
    }

    if (probe.parseStatus === "auth_required") {
      logger.warn({ tag: "buyer_session_auth_wall", profileDir }, "auth wall on wallet probe");
      return { status: "auth_wall", detail: "wallet_probe_auth_required" };
    }

    logger.warn(
      { tag: "buyer_session_stale", profileDir, parseStatus: probe.parseStatus },
      "wallet probe did not recover prices",
    );
    return { status: "stale", detail: `wallet_probe_${probe.parseStatus}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ tag: "buyer_session_stale", err: msg.slice(0, 240) }, "wallet probe threw");
    return { status: "stale", detail: `wallet_probe_exception:${msg.slice(0, 200)}` };
  }
}
