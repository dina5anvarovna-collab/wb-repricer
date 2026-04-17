/**
 * Единый контур buyer auth: источник правды — persistent Playwright profile на диске.
 * storageState — производный артефакт (экспорт куков для axios); БД — зеркало для UI.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import axios from "axios";
import { chromium, type BrowserContext } from "playwright";
import { env } from "../../config/env.js";
import { WB_ENDPOINTS } from "../../config/wbEndpoints.js";
import { resolveWalletDomBrowserKind } from "../wbBuyerDom/runWalletCli.js";
import { resolveLaunchBrowser, type BrowserKind } from "../../walletDom/wbWalletPriceParser.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { runExclusiveBuyerChromeProfile } from "../../lib/buyerChromeProfileLock.js";
import { parseShowcaseRubFromCardDetailJsonOrNested } from "../../walletDom/buyerShowcaseCardRequest.js";
import { fetchShowcaseRubViaPageEvaluate } from "../../walletDom/priceSourceResolver.js";
import AdmZip from "adm-zip";
import {
  exportCookieHeader,
  isWbShowcaseCookieDomain,
  loadSavedSession,
  resolveBuyerProfileDirAbs,
  resolveStorageStatePathAbs,
  saveSession,
  type StorageStateShape,
} from "./buyerStorageIo.js";
import { runtimePaths } from "../../lib/runtimePaths.js";
import type {
  BuyerAuthCanonicalStatus,
  BuyerCookiePipelineResult,
  BuyerProbeResult,
} from "./buyerSessionTypes.js";

const TAG = "buyer-session-manager";

function envTruthyFlag(raw: string | undefined, defaultWhenUnset: boolean): boolean {
  const v = raw?.trim().toLowerCase() ?? "";
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return defaultWhenUnset;
}

/** Автозапуск окна входа WB после POST login/start (по умолчанию только macOS). */
export function buyerLoginAutospawnEnabled(): boolean {
  return envTruthyFlag(env.REPRICER_BUYER_LOGIN_AUTOSPAWN, process.platform === "darwin");
}

/**
 * Явный REPRICER_BUYER_LOGIN_AUTOSTART переопределяет legacy REPRICER_BUYER_LOGIN_AUTOSPAWN.
 * Для VPS задайте REPRICER_BUYER_LOGIN_AUTOSTART=false / 0.
 */
export function buyerLoginAutostartEffective(): boolean {
  const explicit = env.REPRICER_BUYER_LOGIN_AUTOSTART?.trim();
  if (explicit !== undefined && explicit !== "") {
    return envTruthyFlag(env.REPRICER_BUYER_LOGIN_AUTOSTART, false);
  }
  return buyerLoginAutospawnEnabled();
}

/** Разрешено ли интерактивное окно браузера на этой машине (без явного запрета по .env). */
export function headedBrowserLoginEnvironmentOk(): boolean {
  const x = env.REPRICER_HEADED_LOGIN_ALLOWED.trim().toLowerCase();
  if (x === "1" || x === "true" || x === "yes") return true;
  if (x === "0" || x === "false" || x === "no") return false;
  if (process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY?.trim());
}

export function headedBrowserLoginBlockedMessage(): string {
  return "Headed login unavailable on server without X11. Use local login + import profile/storageState or use cookies refresh if supported.";
}

/** Второй probe с headed при «Подтвердить вход» (по умолчанию только macOS). */
function buyerVerifyHeadedRetryEnabled(): boolean {
  return envTruthyFlag(env.REPRICER_BUYER_VERIFY_HEADED_RETRY, process.platform === "darwin");
}

/** VPS / CI: не требовать «толстую» карточку товара для активации сессии. */
export function buyerProbeUsesCookiesOnlyMode(): boolean {
  const v = env.REPRICER_BUYER_VERIFY_MODE.trim().toLowerCase();
  return v === "cookies_only" || v === "server";
}

/**
 * Запуск CLI логина в отдельном процессе (detached), чтобы открылось окно Chromium/Chrome.
 */
export function trySpawnBuyerLoginCli(cliCommand: string): { started: boolean; error?: string } {
  try {
    const child = spawn(cliCommand, {
      shell: true,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", (err) => {
      logger.warn({ tag: TAG, err: String(err) }, "buyer login CLI: spawn error event");
    });
    child.unref();
    return { started: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ tag: TAG, err: msg }, "buyer login CLI: spawn threw");
    return { started: false, error: msg };
  }
}

export function spawnBuyerLoginWindowIfConfigured(cliCommand: string): {
  attempted: boolean;
  started: boolean;
  error?: string;
} {
  if (!buyerLoginAutostartEffective()) {
    return { attempted: false, started: false };
  }
  const r = trySpawnBuyerLoginCli(cliCommand);
  return { attempted: true, started: r.started, error: r.error };
}

function ttlMs(): number {
  return env.REPRICER_BUYER_SESSION_TTL_MIN * 60 * 1000;
}

function probeNmId(): number {
  return env.REPRICER_BUYER_PROBE_NMID;
}

function probeDest(): string {
  return env.REPRICER_WALLET_DEST.trim() || "-1257786";
}

function authWallFromPage(bodyText: string, pageUrl: string): boolean {
  const u = pageUrl.toLowerCase();
  const t = bodyText.slice(0, 12_000);
  if (/капч|captcha|вы\s+робот|подтвердите,\s*что\s+вы\s+не\s+робот/i.test(t)) {
    return true;
  }
  if (/security\/login|passport\.wildberries/i.test(u)) {
    return true;
  }
  /**
   * Футер «вход или регистрация» бывает на почти пустой карточке / антиботе — не считать это страницей логина,
   * если URL явно карточка каталога.
   */
  if (
    t.length < 500 &&
    /войти\s+по\s+коду|вход\s+или\s+регистрация/i.test(t) &&
    !/\/catalog\/\d+\//i.test(u)
  ) {
    return true;
  }
  return false;
}

async function launchBuyerContext(profileDir: string, headed: boolean): Promise<BrowserContext> {
  /**
   * Не используем `channel: "chrome"` — на части macOS/версий Playwright persistent context падает.
   * Тот же выбор бинарника, что и wallet CLI: явный executablePath к Chrome в /Applications или bundled Chromium.
   */
  const override = process.env.REPRICER_DOM_BROWSER?.trim().toLowerCase();
  const kind: BrowserKind =
    override === "chrome" ? "chrome" : override === "chromium" ? "chromium" : resolveWalletDomBrowserKind();
  const resolved = resolveLaunchBrowser(kind);
  const opts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: !headed,
    viewport: { width: 1280, height: 860 },
    locale: "ru-RU",
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
    ...(resolved.executablePath ? { executablePath: resolved.executablePath } : {}),
  };
  logger.info(
    { tag: TAG, browser: kind, executable: resolved.label },
    "buyer context: launch persistent (same binary resolution as wallet CLI)",
  );
  return chromium.launchPersistentContext(path.resolve(profileDir), opts);
}

async function tryShowcaseCardWithCookieHeader(
  cookieHeader: string | null,
  nmId: number,
  dest: string,
): Promise<{ ok: boolean; status?: number; rub: number | null }> {
  if (!cookieHeader?.trim()) {
    return { ok: false, rub: null };
  }
  const url = `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${encodeURIComponent(dest)}&nm=${nmId}`;
  try {
    const res = await axios.get(url, {
      headers: {
        Cookie: cookieHeader,
        Accept: "application/json, text/plain, */*",
        Referer: `${WB_ENDPOINTS.showcaseOrigin}/`,
        Origin: WB_ENDPOINTS.showcaseOrigin,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      timeout: 22_000,
      validateStatus: () => true,
    });
    const status = res.status;
    if (status !== 200) {
      return { ok: false, status, rub: null };
    }
    const rub = parseShowcaseRubFromCardDetailJsonOrNested(res.data, nmId);
    return { ok: rub != null && rub > 0, status: 200, rub };
  } catch (e) {
    logger.warn(
      { tag: TAG, err: e instanceof Error ? e.message : String(e) },
      "buyer probe: axios card.wb.ru не удался",
    );
    return { ok: false, rub: null };
  }
}

/**
 * Полный probe + экспорт storageState из persistent profile.
 */
export async function runBuyerProbeAndExport(opts: {
  profileDir: string;
  headed: boolean;
}): Promise<BuyerProbeResult> {
  return runExclusiveBuyerChromeProfile(() => runBuyerProbeAndExportUnlocked(opts));
}

async function runBuyerProbeAndExportUnlocked(opts: {
  profileDir: string;
  headed: boolean;
}): Promise<BuyerProbeResult> {
  const profileAbs = path.resolve(opts.profileDir);
  if (!fs.existsSync(profileAbs)) {
    await fsp.mkdir(profileAbs, { recursive: true });
  }
  const nm = probeNmId();
  const dest = probeDest();
  const catalogUrl = `https://www.wildberries.ru/catalog/${nm}/detail.aspx`;
  let ctx: BrowserContext | null = null;
  try {
    ctx = await launchBuyerContext(profileAbs, opts.headed);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    /** Сначала главная www.wildberries.ru — часть session/first-party кук выставляется только с корня сайта. */
    await page.goto(`${WB_ENDPOINTS.showcaseOrigin}/`, {
      waitUntil: "domcontentloaded",
      timeout: 75_000,
    });
    await page.waitForTimeout(900);
    await page.goto(catalogUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2200);
    let body = await page.innerText("body").catch(() => "");
    if (body.length < 500) {
      await page.waitForTimeout(2000);
      body = (await page.innerText("body").catch(() => "")) || body;
    }
    const url = page.url();
    const wall = authWallFromPage(body, url);
    const hasDomAccess = !wall && body.length > 480;
    const state = (await ctx.storageState()) as StorageStateShape;
    await saveSession(state);
    const header = exportCookieHeader(state);
    const wbCookies = state.cookies.filter((c) => isWbShowcaseCookieDomain(c.domain));
    const hasCookieAccess = wbCookies.length >= 2 && Boolean(header && header.length > 30);
    const card = await tryShowcaseCardWithCookieHeader(header, nm, dest);
    let hasShowcaseAccess = card.ok;
    if (!hasShowcaseAccess) {
      const rubInPage = await fetchShowcaseRubViaPageEvaluate(page, nm, dest).catch(() => null);
      if (rubInPage != null && rubInPage > 0) {
        hasShowcaseAccess = true;
        logger.info(
          { tag: TAG, nmId: nm, rub: rubInPage },
          "buyer probe: витрина подтвержена fetch() со страницы (как в мониторинге; axios card часто 403)",
        );
      }
    }
    const ok = hasDomAccess && hasCookieAccess;
    const strongAuth = hasStrongBuyerCookies(wbCookies);
    /** axios на card.wb.ru часто 403; мониторинг берёт СПП из DOM/fetch со страницы — не блокируем «свежий» probe. */
    const probeAcceptable = ok && (hasShowcaseAccess || strongAuth);
    const reason = !probeAcceptable
      ? !ok
        ? !hasDomAccess
          ? wall
            ? "auth_wall_or_captcha_on_product_page"
            : "product_page_too_short_or_empty"
          : "insufficient_wb_cookies_after_export"
        : `showcase_card_api_not_confirmed_http_${card.status ?? "na"}`
      : undefined;
    const result: BuyerProbeResult = {
      ok: probeAcceptable,
      hasCookieAccess,
      hasShowcaseAccess,
      hasDomAccess,
      reason,
      showcaseHttpStatus: card.status,
    };
    if (probeAcceptable && !hasShowcaseAccess && strongAuth) {
      logger.info(
        { tag: TAG, nmId: nm, http: card.status },
        "buyer probe: card API не подтвердил витрину, но сессия WB по кукам признана достаточной (как для мониторинга DOM)",
      );
    }
    logger.info(
      {
        tag: TAG,
        nmId: nm,
        dest,
        hasDomAccess,
        hasCookieAccess,
        hasShowcaseAccess,
        ok: result.ok,
        reason: result.reason,
        wbCookieCount: wbCookies.length,
        cardRub: card.rub,
      },
      "buyer probe завершён (карточка товара + экспорт storageState + проверка card.wb.ru)",
    );
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(e, "runBuyerProbeAndExport failed");
    return {
      ok: false,
      hasCookieAccess: false,
      hasShowcaseAccess: false,
      hasDomAccess: false,
      reason: msg.slice(0, 400),
    };
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  }
}

const STRONG_AUTH_COOKIE_NAMES = new Set([
  "_wbauid",
  "x_wbaas",
  "wbx-refresh",
  "WBTokenV3",
  "wbToken",
  "jwt_global",
  "__wuid",
  "x-supplier-id-external",
]);

function hasStrongBuyerCookies(
  cookies: Array<{ name: string; value?: string; domain?: string }>,
): boolean {
  const wb = cookies.filter((c) => isWbShowcaseCookieDomain(c.domain ?? ""));
  return wb.some((c) => STRONG_AUTH_COOKIE_NAMES.has(c.name));
}

function parseStorageStateImportBody(body: unknown): StorageStateShape {
  if (!body || typeof body !== "object") {
    throw new Error("Ожидался JSON-объект Playwright storageState");
  }
  const raw = body as Record<string, unknown>;
  const cookies = raw.cookies;
  if (!Array.isArray(cookies) || cookies.length < 2) {
    throw new Error("storageState.cookies: нужен массив минимум из 2 cookie");
  }
  if (cookies.length > 600) {
    throw new Error("storageState.cookies: слишком много записей");
  }
  for (let i = 0; i < Math.min(cookies.length, 50); i += 1) {
    const c = cookies[i] as Record<string, unknown>;
    if (!c || typeof c.name !== "string" || typeof c.value !== "string") {
      throw new Error(`storageState.cookies[${i}]: нужны поля name и value (строки)`);
    }
  }
  return body as StorageStateShape;
}

/**
 * Подмешивает куки из JSON в persistent-профиль и переснимает storageState (нужно для Playwright на сервере).
 */
async function syncImportedStorageIntoProfile(state: StorageStateShape): Promise<void> {
  await runExclusiveBuyerChromeProfile(async () => {
    const profileDir = await ensureProfileDirExists();
    let ctx: BrowserContext | null = null;
    try {
      ctx = await launchBuyerContext(profileDir, false);
    const toAdd = state.cookies
      .filter((c) => isWbShowcaseCookieDomain(c.domain) && c.name && c.value)
      .map((c) => {
        let domain = String(c.domain).trim().toLowerCase();
        if (!domain.startsWith(".")) {
          domain = `.${domain}`;
        }
        return {
          name: c.name,
          value: c.value,
          domain,
          path: (c.path && String(c.path).trim()) || "/",
          secure: true,
          sameSite: "Lax" as const,
          expires: -1,
        };
      });
    if (toAdd.length > 0) {
      await ctx.addCookies(toAdd);
    }
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${WB_ENDPOINTS.showcaseOrigin}/`, {
      waitUntil: "domcontentloaded",
      timeout: 75_000,
    });
    await page.waitForTimeout(1200);
      const merged = (await ctx.storageState()) as StorageStateShape;
      await saveSession(merged);
    } finally {
      if (ctx) {
        await ctx.close().catch(() => {});
      }
    }
  });
}

/**
 * Облегчённый probe для VPS: главная WB, без требования «толстой» карточки nmId.
 */
export async function runBuyerProbeCookiesOnlyExport(opts: {
  profileDir: string;
}): Promise<BuyerProbeResult> {
  return runExclusiveBuyerChromeProfile(() => runBuyerProbeCookiesOnlyExportUnlocked(opts));
}

async function runBuyerProbeCookiesOnlyExportUnlocked(opts: {
  profileDir: string;
}): Promise<BuyerProbeResult> {
  const profileAbs = path.resolve(opts.profileDir);
  if (!fs.existsSync(profileAbs)) {
    await fsp.mkdir(profileAbs, { recursive: true });
  }
  const nm = probeNmId();
  const dest = probeDest();
  const origin = `${WB_ENDPOINTS.showcaseOrigin}/`;
  let ctx: BrowserContext | null = null;
  try {
    ctx = await launchBuyerContext(profileAbs, false);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 75_000 });
    await page.waitForTimeout(1800);
    const state = (await ctx.storageState()) as StorageStateShape;
    await saveSession(state);
    const header = exportCookieHeader(state);
    const wbCookies = state.cookies.filter((c) => isWbShowcaseCookieDomain(c.domain));
    const hasCookieAccess = wbCookies.length >= 2 && Boolean(header && header.length > 30);
    const strongAuth = hasStrongBuyerCookies(wbCookies);
    const card = await tryShowcaseCardWithCookieHeader(header, nm, dest);
    let hasShowcaseAccess = card.ok;
    if (!hasShowcaseAccess) {
      const rubInPage = await fetchShowcaseRubViaPageEvaluate(page, nm, dest).catch(() => null);
      if (rubInPage != null && rubInPage > 0) {
        hasShowcaseAccess = true;
      }
    }
    const okCore = hasCookieAccess && (strongAuth || hasShowcaseAccess);
    const hasDomAccess = strongAuth || hasShowcaseAccess;
    const reason = okCore
      ? undefined
      : !hasCookieAccess
        ? "insufficient_wb_cookies_after_export"
        : "cookies_only_need_strong_session_cookie_or_card";
    const result: BuyerProbeResult = {
      ok: okCore,
      hasCookieAccess,
      hasShowcaseAccess,
      hasDomAccess,
      reason,
      showcaseHttpStatus: card.status,
    };
    logger.info(
      {
        tag: TAG,
        mode: "cookies_only",
        nmId: nm,
        dest,
        hasCookieAccess,
        hasShowcaseAccess,
        strongAuth,
        ok: result.ok,
        reason: result.reason,
        wbCookieCount: wbCookies.length,
        cardRub: card.rub,
      },
      "buyer probe (cookies_only): главная WB + куки + card",
    );
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(e, "runBuyerProbeCookiesOnlyExport failed");
    return {
      ok: false,
      hasCookieAccess: false,
      hasShowcaseAccess: false,
      hasDomAccess: false,
      reason: msg.slice(0, 400),
    };
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  }
}

/**
 * Импорт storageState с рабочего ПК на сервер (curl / админка). Куки подмешиваются в профиль Playwright.
 */
export async function importBuyerStorageStateFromJson(body: unknown): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    const state = parseStorageStateImportBody(body);
    await saveSession(state);
    await syncImportedStorageIntoProfile(state);
    const st = await loadSavedSession();
    if (!st) {
      return { ok: false, message: "Не удалось прочитать сохранённый storageState после импорта" };
    }
    const header = exportCookieHeader(st);
    const wbCookies = st.cookies.filter((c) => isWbShowcaseCookieDomain(c.domain));
    const hasCookieAccess = wbCookies.length >= 2 && Boolean(header && header.length > 30);
    const strongAuth = hasStrongBuyerCookies(wbCookies);
    const card = await tryShowcaseCardWithCookieHeader(header, probeNmId(), probeDest());
    const ok = hasCookieAccess && (strongAuth || card.ok);
    if (!ok) {
      return {
        ok: false,
        message:
          "Импорт записан, но проверка не прошла: мало кук WB или нет признаков входа и card.wb.ru не ответил. Экспортируйте storageState после входа в аккаунт на wildberries.ru в профиле Chromium.",
      };
    }
    const profileDir = resolveBuyerProfileDirAbs();
    const existing = await prisma.buyerSession.findFirst({ orderBy: { updatedAt: "desc" } });
    if (existing) {
      await prisma.buyerSession.update({
        where: { id: existing.id },
        data: {
          profileDir,
          isAuthorized: true,
          status: "active",
          lastSuccessAt: new Date(),
          lastValidatedAt: new Date(),
          lastProbeOk: true,
          lastProbeReason: "import_storage_state_json",
          lastStorageExportAt: new Date(),
          notes: null,
        },
      });
    } else {
      await prisma.buyerSession.create({
        data: {
          profileDir,
          isAuthorized: true,
          status: "active",
          lastSuccessAt: new Date(),
          lastValidatedAt: new Date(),
          lastProbeOk: true,
          lastProbeReason: "import_storage_state_json",
          lastStorageExportAt: new Date(),
        },
      });
    }
    await mirrorAuthSessionBuyerRow({
      status: "active",
      lastError: null,
      lastValidatedAt: new Date(),
      lastRefreshAt: new Date(),
    });
    logger.info({ tag: TAG }, "buyer storageState импортирован с диска, сессия активирована");
    return {
      ok: true,
      message:
        "storageState импортирован, куки подмешаны в профиль Playwright. На сервере в .env задайте REPRICER_BUYER_VERIFY_MODE=cookies_only или public_first для VPS.",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

/**
 * ZIP архива Chromium user-data (`.wb-browser-profile`), собранный локально после входа.
 */
export async function importBuyerBrowserProfileArchive(buffer: Buffer): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    if (!buffer?.length) {
      return { ok: false, message: "Пустое тело запроса." };
    }
    if (buffer.length > 120 * 1024 * 1024) {
      return { ok: false, message: "Архив больше 120MB — уменьшите или добавьте в исключение кэши." };
    }
    const profileDir = resolveBuyerProfileDirAbs();
    const extractRoot = path.join(runtimePaths.tmpDir, `wb-profile-import-${Date.now()}`);
    await fsp.mkdir(extractRoot, { recursive: true });
    try {
      const zip = new AdmZip(buffer);
      zip.extractAllTo(extractRoot, true);
      const top = await fsp.readdir(extractRoot);
      let sourceRoot = extractRoot;
      if (top.length === 1) {
        const candidate = path.join(extractRoot, top[0]!);
        const st = await fsp.stat(candidate);
        if (st.isDirectory()) sourceRoot = candidate;
      }
      const backupPath = `${profileDir}.bak-import-${Date.now()}`;
      if (fs.existsSync(profileDir)) {
        try {
          await fsp.rename(profileDir, backupPath);
        } catch {
          return {
            ok: false,
            message:
              "Не удалось переместить текущий профиль (возможен lock браузера). Остановите wb-repricer и повторите импорт.",
          };
        }
      }
      await fsp.mkdir(path.dirname(profileDir), { recursive: true });
      await fsp.cp(sourceRoot, profileDir, { recursive: true });

      const existing = await prisma.buyerSession.findFirst({ orderBy: { updatedAt: "desc" } });
      const notes = JSON.stringify({
        phase: "profile_archive_imported",
        importedAt: new Date().toISOString(),
        backupPath,
      });
      if (existing) {
        await prisma.buyerSession.update({
          where: { id: existing.id },
          data: {
            profileDir,
            isAuthorized: false,
            status: "pending_login",
            lastProbeOk: false,
            lastProbeReason: "profile_zip_imported_needs_confirm",
            notes,
          },
        });
      } else {
        await prisma.buyerSession.create({
          data: {
            profileDir,
            isAuthorized: false,
            status: "pending_login",
            lastProbeOk: false,
            lastProbeReason: "profile_zip_imported_needs_confirm",
            notes,
          },
        });
      }
      await mirrorAuthSessionBuyerRow({
        status: "invalid",
        lastError: "profile_zip_imported_needs_confirm",
        lastValidatedAt: new Date(),
      });
      logger.info({ tag: TAG, profileDir, backupPath }, "buyer profile archive imported (pending confirm)");
      return {
        ok: true,
        message:
          "Архив профиля развёрнут. Выполните «Подтвердить вход» или импорт storageState, затем мониторинг. Рекомендуется перезапуск сервиса после импорта.",
      };
    } finally {
      await fsp.rm(extractRoot, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

export async function mirrorAuthSessionBuyerRow(input: {
  status: string;
  lastError: string | null;
  lastValidatedAt?: Date;
  lastRefreshAt?: Date;
}): Promise<void> {
  const storageStatePath = resolveStorageStatePathAbs();
  const profileDir = resolveBuyerProfileDirAbs();
  await prisma.authSession.upsert({
    where: { kind: "buyer_browser" },
    create: {
      kind: "buyer_browser",
      status: input.status,
      lastError: input.lastError,
      lastValidatedAt: input.lastValidatedAt ?? null,
      lastRefreshAt: input.lastRefreshAt ?? null,
      lastCookieExportAt: new Date(),
      storageStatePath,
      profileDir,
      metaJson: JSON.stringify({ source: "buyerSessionManager" }),
    },
    update: {
      status: input.status,
      lastError: input.lastError,
      ...(input.lastValidatedAt ? { lastValidatedAt: input.lastValidatedAt } : {}),
      ...(input.lastRefreshAt ? { lastRefreshAt: input.lastRefreshAt } : {}),
      lastCookieExportAt: new Date(),
      storageStatePath,
      profileDir,
    },
  });
}

export async function ensureProfileDirExists(): Promise<string> {
  const dir = resolveBuyerProfileDirAbs();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Cookie header для axios: «fresh» только если недавний успешный probe в БД.
 */
export async function getCookieHeaderForPipeline(): Promise<BuyerCookiePipelineResult> {
  const row = await prisma.buyerSession.findFirst({
    where: { isAuthorized: true, status: "active", lastProbeOk: true },
    orderBy: { updatedAt: "desc" },
  });
  const st = await loadSavedSession();
  const header = exportCookieHeader(st);
  if (!header) {
    return { header: null, validation: "none", reason: "no_storage_state_or_empty_cookies" };
  }
  const t = row?.lastValidatedAt?.getTime() ?? 0;
  const fresh = row != null && Date.now() - t < ttlMs();
  if (fresh) {
    logger.info(
      { tag: TAG, validation: "fresh", ttlMin: env.REPRICER_BUYER_SESSION_TTL_MIN },
      "cookie header: используем файл storageState (probe недавно подтверждён в БД)",
    );
    return { header, validation: "fresh", reason: null };
  }
  logger.warn(
    {
      tag: TAG,
      validation: "stale",
      lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
    },
    "cookie header: файл есть, но нет свежего probe — пометка stale (нужен refresh или login/finish)",
  );
  return {
    header,
    validation: "stale",
    reason: row?.lastProbeReason ?? "probe_stale_or_never_validated",
  };
}

/** Обратная совместимость для sessionManager / axios. */
export async function getValidCookies(): Promise<{
  header: string | null;
  from: "file" | "none";
  validated: boolean;
}> {
  const r = await getCookieHeaderForPipeline();
  return {
    header: r.header,
    from: r.header ? "file" : "none",
    validated: r.validation === "fresh",
  };
}

export async function getBuyerAuthStatus(): Promise<{
  canonical: BuyerAuthCanonicalStatus;
  profileDir: string;
  storageStatePath: string;
  lastValidatedAt: string | null;
  lastProbeOk: boolean;
  lastProbeReason: string | null;
}> {
  const profileDir = resolveBuyerProfileDirAbs();
  const storageStatePath = resolveStorageStatePathAbs();
  const row = await prisma.buyerSession.findFirst({
    orderBy: { updatedAt: "desc" },
  });
  const st: BuyerAuthCanonicalStatus =
    (row?.status as BuyerAuthCanonicalStatus) ?? "unknown";
  return {
    canonical: row?.status === "pending_login" ? "pending_login" : st,
    profileDir,
    storageStatePath,
    lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
    lastProbeOk: row?.lastProbeOk ?? false,
    lastProbeReason: row?.lastProbeReason ?? null,
  };
}

export async function markSessionExpired(reason: string): Promise<void> {
  const latest = await prisma.buyerSession.findFirst({ orderBy: { updatedAt: "desc" } });
  if (latest) {
    await prisma.buyerSession.update({
      where: { id: latest.id },
      data: {
        status: "expired",
        isAuthorized: false,
        lastProbeOk: false,
        lastProbeReason: reason.slice(0, 500),
        lastValidatedAt: new Date(),
      },
    });
  }
  await mirrorAuthSessionBuyerRow({ status: "expired", lastError: reason, lastValidatedAt: new Date() });
}

/**
 * После «Подтвердить вход» в UI: реальный probe, без этого active не ставим.
 */
export async function verifyBuyerSessionAfterLogin(sessionId: string): Promise<{
  ok: boolean;
  message: string;
  probe: BuyerProbeResult;
  session?: { id: string; status: string; lastProbeOk: boolean };
}> {
  const row = await prisma.buyerSession.findUnique({ where: { id: sessionId } });
  if (!row) {
    return { ok: false, message: "session not found", probe: { ok: false, hasCookieAccess: false, hasShowcaseAccess: false, hasDomAccess: false, reason: "not_found" } };
  }
  const profileAbs = path.resolve(row.profileDir);
  const cookiesOnly = buyerProbeUsesCookiesOnlyMode();
  let probe = cookiesOnly
    ? await runBuyerProbeCookiesOnlyExport({ profileDir: profileAbs })
    : await runBuyerProbeAndExport({ profileDir: profileAbs, headed: false });
  if (!probe.ok && buyerVerifyHeadedRetryEnabled() && !cookiesOnly) {
    logger.info({ tag: TAG, sessionId }, "login/finish: повтор probe с видимым окном (headed)");
    probe = await runBuyerProbeAndExport({ profileDir: profileAbs, headed: true });
  }
  if (!probe.ok) {
    const reason = probe.reason ?? "probe_failed";
    await prisma.buyerSession.update({
      where: { id: sessionId },
      data: {
        isAuthorized: false,
        status: "invalid",
        lastProbeOk: false,
        lastProbeReason: reason,
        lastValidatedAt: new Date(),
        notes: JSON.stringify({ finishRejectedAt: new Date().toISOString(), reason }),
      },
    });
    await mirrorAuthSessionBuyerRow({
      status: "invalid",
      lastError: reason,
      lastValidatedAt: new Date(),
    });
    return {
      ok: false,
      message:
        "Вход не подтверждён: проверка профиля не прошла (карточка WB, куки или витрина). Убедитесь, что в открытом окне вы вошли в аккаунт WB, затем снова «Подтвердить вход». На сервере без GUI задайте REPRICER_BUYER_VERIFY_HEADED_RETRY=0 и выполните вход на машине с дисплеем. При пустой карточке в headless попробуйте REPRICER_DOM_BROWSER=chrome в .env.",
      probe,
    };
  }
  const s = await prisma.buyerSession.update({
    where: { id: sessionId },
    data: {
      isAuthorized: true,
      status: "active",
      lastSuccessAt: new Date(),
      lastValidatedAt: new Date(),
      lastProbeOk: true,
      lastProbeReason:
        probe.reason ??
        (probe.hasShowcaseAccess
          ? "probe_ok_dom_cookie_showcase"
          : "probe_ok_dom_cookie_no_showcase"),
      lastStorageExportAt: new Date(),
      notes: JSON.stringify({
        validation: "fresh",
        validationReason:
          probe.reason ??
          (probe.hasShowcaseAccess
            ? "probe_ok_dom_cookie_showcase"
            : "probe_ok_dom_cookie_no_showcase"),
        probeOk: true,
        hasDomAccess: probe.hasDomAccess === true,
        hasCookieAccess: probe.hasCookieAccess === true,
        hasShowcaseAccess: probe.hasShowcaseAccess === true,
      }),
    },
  });
  await mirrorAuthSessionBuyerRow({
    status: "active",
    lastError: null,
    lastValidatedAt: new Date(),
    lastRefreshAt: new Date(),
  });
  logger.info(
    {
      tag: TAG,
      sessionId,
      validation: "fresh",
      lastValidatedAt: s.lastValidatedAt?.toISOString() ?? null,
      validationReason:
        probe.reason ??
        (probe.hasShowcaseAccess
          ? "probe_ok_dom_cookie_showcase"
          : "probe_ok_dom_cookie_no_showcase"),
      hasDomAccess: probe.hasDomAccess,
      hasCookieAccess: probe.hasCookieAccess,
      hasShowcaseAccess: probe.hasShowcaseAccess,
    },
    "login/finish: buyer session активирован после успешного probe",
  );
  return {
    ok: true,
    message: buyerProbeUsesCookiesOnlyMode()
      ? "Сессия покупателя подтверждена (режим cookies_only: главная WB + куки + витрина/card)"
      : "Сессия покупателя подтверждена (карточка + card API + storageState)",
    probe,
    session: { id: s.id, status: s.status, lastProbeOk: s.lastProbeOk },
  };
}

/**
 * Soft refresh: переснять storageState и probe (без headed), обновить БД.
 */
export async function refreshBuyerSessionIfNeeded(opts?: {
  headed?: boolean;
  force?: boolean;
}): Promise<{ ok: boolean; message: string; probe?: BuyerProbeResult }> {
  const profileDir = await ensureProfileDirExists();
  const headed = opts?.headed === true;
  const row = await prisma.buyerSession.findFirst({
    where: { isAuthorized: true, status: "active" },
    orderBy: { updatedAt: "desc" },
  });
  if (!opts?.force && row?.lastValidatedAt && Date.now() - row.lastValidatedAt.getTime() < ttlMs()) {
    return { ok: true, message: "Профиль свежий, soft refresh пропущен" };
  }
  const probe =
    buyerProbeUsesCookiesOnlyMode() && !headed
      ? await runBuyerProbeCookiesOnlyExport({ profileDir })
      : await runBuyerProbeAndExport({ profileDir, headed });
  if (!probe.ok) {
    await mirrorAuthSessionBuyerRow({
      status: "expired",
      lastError: probe.reason ?? "refresh_probe_failed",
      lastValidatedAt: new Date(),
      lastRefreshAt: new Date(),
    });
    return { ok: false, message: probe.reason ?? "refresh failed", probe };
  }
  const toUpdate =
    row ??
    (await prisma.buyerSession.findFirst({
      where: { profileDir },
      orderBy: { updatedAt: "desc" },
    }));
  const now = new Date();
  const validationFresh =
    probe.ok === true &&
    probe.hasDomAccess === true &&
    probe.hasCookieAccess === true;
  const validationReason =
    probe.reason ??
    (probe.hasShowcaseAccess
      ? "probe_ok_dom_cookie_showcase"
      : "probe_ok_dom_cookie_no_showcase");
  const validationMeta = JSON.stringify({
    validation: validationFresh ? "fresh" : "stale",
    validationReason,
    probeOk: probe.ok === true,
    hasDomAccess: probe.hasDomAccess === true,
    hasCookieAccess: probe.hasCookieAccess === true,
    hasShowcaseAccess: probe.hasShowcaseAccess === true,
    validatedAt: now.toISOString(),
  });
  if (toUpdate) {
    await prisma.buyerSession.update({
      where: { id: toUpdate.id },
      data: {
        profileDir,
        isAuthorized: validationFresh,
        status: validationFresh ? "active" : "invalid",
        ...(validationFresh ? { lastSuccessAt: now } : {}),
        lastValidatedAt: now,
        lastProbeOk: validationFresh,
        lastProbeReason: validationReason,
        lastStorageExportAt: now,
        notes: validationMeta,
      },
    });
  } else {
    await prisma.buyerSession.create({
      data: {
        profileDir,
        isAuthorized: validationFresh,
        status: validationFresh ? "active" : "invalid",
        ...(validationFresh ? { lastSuccessAt: now } : {}),
        lastValidatedAt: now,
        lastProbeOk: validationFresh,
        lastProbeReason: validationReason,
        lastStorageExportAt: now,
        notes: validationMeta,
      },
    });
  }
  await mirrorAuthSessionBuyerRow({
    status: validationFresh ? "active" : "invalid",
    lastError: validationFresh ? null : validationReason,
    lastValidatedAt: now,
    lastRefreshAt: now,
  });
  logger.info(
    {
      tag: TAG,
      validation: validationFresh ? "fresh" : "stale",
      lastValidatedAt: now.toISOString(),
      validationReason,
      hasDomAccess: probe.hasDomAccess,
      hasCookieAccess: probe.hasCookieAccess,
      hasShowcaseAccess: probe.hasShowcaseAccess,
    },
    "buyer probe persisted to session state",
  );
  return { ok: true, message: "storageState переснят, buyer probe успешен", probe };
}

function monitorSkipCookieRefreshBeforeJob(): boolean {
  const v = env.REPRICER_MONITOR_SKIP_COOKIE_REFRESH_BEFORE_JOB.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Перед мониторингом: при устаревшем probe попытаться обновить headless. */
export async function prepareBuyerSessionForMonitor(): Promise<void> {
  if (monitorSkipCookieRefreshBeforeJob()) {
    logger.info(
      { tag: TAG },
      "monitor: пропуск refresh buyer cookies (REPRICER_MONITOR_SKIP_COOKIE_REFRESH_BEFORE_JOB)",
    );
    return;
  }
  const r = await getCookieHeaderForPipeline();
  if (r.validation === "fresh") {
    logger.info({ tag: TAG }, "monitor: buyer cookie pipeline fresh — пропускаем soft refresh");
    return;
  }
  const res = await refreshBuyerSessionIfNeeded({ force: true });
  if (!res.ok) {
    logger.warn(
      { tag: TAG, message: res.message },
      "monitor: buyer soft refresh не удался — мониторинг может получить 403 на витрине",
    );
  }
}

export function requireInteractiveLoginMessage(): string {
  return "Требуется интерактивный вход: npm run wallet:login или кнопка в UI (CLI), затем «Подтвердить вход».";
}
