import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import { env } from "../config/env.js";
import { isPublicOnlyWalletParse } from "../lib/repricerMode.js";
import { runExclusiveBuyerChromeProfile } from "../lib/buyerChromeProfileLock.js";
import { logger } from "../lib/logger.js";
import {
  buildPublicPersistentLaunchOptions,
  buildPublicProxyFromEnv,
  envPublicParseDebugEnabled,
  publicExtraWaitMs,
  randomPublicJitterWaitMs,
  resolvePublicBrowserHeadless,
} from "../lib/publicBrowserRuntime.js";
import { detectPublicParseBlockSignals, type PublicParseBlockReason } from "../lib/publicParseBlockReason.js";
import { savePublicParseDebugArtifacts } from "../lib/publicParseDebug.js";
import { resolveStockLevel } from "../lib/stockLevel.js";
import { tryShowcaseRubViaCardWbTopLevelNavigation } from "./cardWbTopNavigation.js";
import {
  parseShowcaseRubFromCardDetailJsonOrNested,
  parseWalletRubFromCardDetailJsonOrNested,
} from "./buyerShowcaseCardRequest.js";
import {
  fetchShowcaseRubViaPageEvaluate,
  resolveShowcaseForMonitorStep,
} from "./priceSourceResolver.js";
import {
  computeBuyerPriceVerification,
  type BuyerPriceVerificationSnapshot,
} from "../modules/pricing/buyerPriceVerification.js";
import { walletArtifactsDir } from "../lib/runtimePaths.js";

export type BrowserKind = "chrome" | "chromium";

const MAC_GOOGLE_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_GOOGLE_CHROME_CANARY =
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
const MAC_GOOGLE_CHROME_BETA =
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
const LINUX_CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
] as const;

const LOGIN_URL_SEQUENCE = [
  "https://www.wildberries.ru/security/login",
  "https://www.wildberries.ru/lk",
  "https://www.wildberries.ru/",
] as const;

/** Chrome/Chromium create these in the profile root; stale files after crash/Ctrl+C block the next launch. */
const PROFILE_SINGLETON_ARTIFACTS = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;
const ARTIFACTS_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastArtifactsPruneAt = 0;
const execFileAsync = promisify(execFile);

function envTruthy(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function maybePruneWalletArtifacts(dir: string): Promise<void> {
  const now = Date.now();
  if (now - lastArtifactsPruneAt < ARTIFACTS_PRUNE_INTERVAL_MS) {
    return;
  }
  lastArtifactsPruneAt = now;

  const maxFiles = env.REPRICER_WALLET_ARTIFACTS_MAX_FILES;
  const maxAgeMs = env.REPRICER_WALLET_ARTIFACTS_MAX_AGE_HOURS * 60 * 60 * 1000;

  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const full = names.map((name) => path.join(dir, name));
  const stats = await Promise.all(
    full.map(async (p) => {
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) return null;
        return { path: p, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const files = stats.filter((x): x is { path: string; mtimeMs: number } => x != null);
  if (files.length === 0) {
    return;
  }

  const toDelete = new Set<string>();
  for (const f of files) {
    if (now - f.mtimeMs > maxAgeMs) {
      toDelete.add(f.path);
    }
  }

  const fresh = files
    .filter((f) => !toDelete.has(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (fresh.length > maxFiles) {
    for (const f of fresh.slice(maxFiles)) {
      toDelete.add(f.path);
    }
  }

  if (toDelete.size === 0) {
    return;
  }
  await Promise.allSettled([...toDelete].map((p) => fsp.unlink(p)));
  logger.debug(
    { tag: "wb-wallet-artifacts", removed: toDelete.size, maxFiles, maxAgeHours: env.REPRICER_WALLET_ARTIFACTS_MAX_AGE_HOURS },
    "auto-cleaned old wb-wallet artifacts",
  );
}

function isProfileSingletonLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /ProcessSingleton/i.test(msg) ||
    /SingletonLock/i.test(msg) ||
    /profile is already in use/i.test(msg) ||
    (/Failed to create a ProcessSingleton/i.test(msg) &&
      /profile directory/i.test(msg))
  );
}

/**
 * Removes stale singleton lock files so a new browser instance can open the profile.
 * If another live process still holds this profile, deleting these can risk corruption — close that browser first.
 */
export async function removeProfileSingletonArtifacts(profileDir: string): Promise<void> {
  const abs = path.resolve(profileDir);
  for (const name of PROFILE_SINGLETON_ARTIFACTS) {
    const p = path.join(abs, name);
    try {
      await fsp.unlink(p);
      // eslint-disable-next-line no-console
      console.warn(`[wb-wallet] removed profile singleton artifact: ${p}`);
    } catch (e: unknown) {
      const code =
        e && typeof e === "object" && "code" in e
          ? (e as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn(`[wb-wallet] could not remove ${p}:`, e);
      }
    }
  }
}

async function launchPersistentContextWithSingletonRetry(
  userDataDir: string,
  launchOpts: Parameters<typeof chromium.launchPersistentContext>[1],
  opts: { preUnlock: boolean },
): Promise<BrowserContext> {
  const abs = path.resolve(userDataDir);
  if (opts.preUnlock) {
    // eslint-disable-next-line no-console
    console.warn(
      "[wb-wallet] unlock-profile: clearing Singleton* files before launch (ensure no browser uses this profile)",
    );
    await removeProfileSingletonArtifacts(abs);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(abs, launchOpts);
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isProfileSingletonLockError(err)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[wb-wallet] profile locked (stale Singleton* or second instance using this userDataDir). Removing SingletonLock/SingletonSocket/SingletonCookie and retrying once…",
        );
        await removeProfileSingletonArtifacts(abs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function isExecutableOrReadable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export type ResolvedBrowser = {
  /** What the user asked for */
  requested: BrowserKind;
  /** Playwright: omit for bundled Chromium */
  executablePath: string | undefined;
  /** Log / diagnostics: what actually backs the launch */
  label: string;
};

/**
 * Resolve browser executable: macOS tries stable Chrome, then Canary; otherwise bundled Chromium.
 * Non-macOS with browser=chrome: CHROME_PATH if set and exists, else fallback to bundled Chromium.
 */
export function resolveLaunchBrowser(requested: BrowserKind): ResolvedBrowser {
  const explicitExecutable = env.BROWSER_EXECUTABLE_PATH.trim();
  if (explicitExecutable && isExecutableOrReadable(explicitExecutable)) {
    return {
      requested,
      executablePath: explicitExecutable,
      label: explicitExecutable,
    };
  }
  if (requested === "chromium") {
    return {
      requested,
      executablePath: undefined,
      label: "playwright bundled Chromium",
    };
  }
  if (process.platform === "darwin") {
    if (isExecutableOrReadable(MAC_GOOGLE_CHROME)) {
      return {
        requested,
        executablePath: MAC_GOOGLE_CHROME,
        label: MAC_GOOGLE_CHROME,
      };
    }
    if (isExecutableOrReadable(MAC_GOOGLE_CHROME_CANARY)) {
      return {
        requested,
        executablePath: MAC_GOOGLE_CHROME_CANARY,
        label: MAC_GOOGLE_CHROME_CANARY,
      };
    }
    if (isExecutableOrReadable(MAC_GOOGLE_CHROME_BETA)) {
      return {
        requested,
        executablePath: MAC_GOOGLE_CHROME_BETA,
        label: MAC_GOOGLE_CHROME_BETA,
      };
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[wb-wallet] browser=chrome: Chrome / Canary / Beta not found under /Applications; using Playwright Chromium",
    );
    return {
      requested,
      executablePath: undefined,
      label:
        "playwright bundled Chromium (fallback: no /Applications/Google Chrome[ Canary].app)",
    };
  }
  const envChrome = process.env.CHROME_PATH?.trim();
  if (envChrome && isExecutableOrReadable(envChrome)) {
    return { requested, executablePath: envChrome, label: envChrome };
  }
  for (const linuxPath of LINUX_CHROME_CANDIDATES) {
    if (isExecutableOrReadable(linuxPath)) {
      return { requested, executablePath: linuxPath, label: linuxPath };
    }
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[wb-wallet] browser=chrome: set BROWSER_EXECUTABLE_PATH/CHROME_PATH or install chrome/chromium. Using bundled Chromium.",
  );
  return {
    requested,
    executablePath: undefined,
    label: "playwright bundled Chromium (fallback: no external executable)",
  };
}

async function bodyInnerTextLength(page: Page): Promise<number> {
  return page.evaluate(() => document.body?.innerText?.length ?? 0);
}

async function waitDomContentThenPriceReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
  const selectors = [
    "[class*='price']",
    "[data-link*='price']",
    "[class*='price-block']",
    "[class*='product-page']",
  ];
  for (let i = 0; i < 4; i += 1) {
    for (const s of selectors) {
      await page.waitForSelector(s, { state: "attached", timeout: 2200 }).catch(() => {});
    }
    const text = await page.innerText("body").catch(() => "");
    if (/(₽|руб)/i.test(text)) return;
    await page.waitForTimeout(450);
  }
}

async function logBlankPageDiagnostics(
  page: Page,
  resolvedBrowserLabel: string,
  tag: string,
): Promise<void> {
  const url = page.url();
  const ua = await page.evaluate(() => navigator.userAgent);
  const len = await bodyInnerTextLength(page);
  // eslint-disable-next-line no-console
  console.error(`[wb-wallet] empty/blank page (${tag})`);
  // eslint-disable-next-line no-console
  console.error(`[wb-wallet] url=${url}`);
  // eslint-disable-next-line no-console
  console.error(`[wb-wallet] document.body.innerText.length=${len}`);
  // eslint-disable-next-line no-console
  console.error(`[wb-wallet] userAgent=${ua}`);
  // eslint-disable-next-line no-console
  console.error(`[wb-wallet] browserExecutable=${resolvedBrowserLabel}`);
  const dir = walletArtifactsDir();
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const shot = path.join(dir, `blank-${tag}-${ts}.png`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
    // eslint-disable-next-line no-console
    console.error(`[wb-wallet] screenshot=${shot}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[wb-wallet] screenshot failed:", e);
  }
}

async function gotoVerified(
  page: Page,
  targetUrl: string,
  resolvedBrowserLabel: string,
  diagTag: string,
): Promise<{ ok: boolean; httpStatus: number | null }> {
  let httpStatus: number | null = null;
  try {
    const resp = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    httpStatus = resp?.status() ?? null;
  } catch (e) {
    await logBlankPageDiagnostics(page, resolvedBrowserLabel, diagTag).catch(() => {});
    throw e;
  }
  await waitDomContentThenPriceReady(page);
  const len = await bodyInnerTextLength(page);
  if (len > 0) {
    return { ok: true, httpStatus };
  }
  await logBlankPageDiagnostics(page, resolvedBrowserLabel, diagTag);
  return { ok: false, httpStatus };
}

async function openLoginFlow(
  page: Page,
  resolvedBrowserLabel: string,
): Promise<void> {
  let opened = false;
  for (let i = 0; i < LOGIN_URL_SEQUENCE.length; i += 1) {
    const u = LOGIN_URL_SEQUENCE[i];
    try {
      const nav = await gotoVerified(page, u, resolvedBrowserLabel, `login-${i}`);
      if (nav.ok) {
        opened = true;
        break;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[wb-wallet] login navigation failed (${u}):`, err);
      await logBlankPageDiagnostics(page, resolvedBrowserLabel, `login-err-${i}`).catch(() => {});
    }
  }
  if (!opened) {
    throw new Error(
      `[wb-wallet] could not load Wildberries login (tried security/login, lk, /). Browser: ${resolvedBrowserLabel}. Check artifacts/wb-wallet for screenshots.`,
    );
  }
}

export type WalletParserInput = {
  url?: string;
  nmId?: number;
  userDataDir: string;
  proxy?: string;
  region?: string;
  headless?: boolean;
  loginMode?: boolean;
  /** Индекс попытки public retry (логи). */
  attemptIndex?: number;
  /**
   * Принудительно применить REPRICER_PUBLIC_* (проба карточки / тест), даже если режим не public_only.
   */
  applyPublicBrowserEnv?: boolean;
  /**
   * chrome: prefer installed Google Chrome (macOS paths or CHROME_PATH); else bundled Chromium.
   * chromium: always Playwright's bundled browser (for testing / CI).
   */
  browser?: BrowserKind;
  /**
   * Delete Chrome/Chromium Singleton* files in the profile before launch.
   * Also set env WB_WALLET_UNLOCK_PROFILE=1 for the same effect.
   */
  forceUnlockProfile?: boolean;
  /**
   * Витрина/card.wb.ru после DOM (независимо от wallet batch).
   * Кошелёк по-прежнему только из DOM страницы.
   */
  fetchShowcaseWithCookies?: boolean;
};

export type WalletParseStatus =
  | "wallet_found"
  | "only_regular_found"
  | "parse_failed"
  | "auth_required"
  | "blocked_or_captcha";

/** Источник цены на публичной витрине (PUBLIC ONLY — без buyer/cookies). */
export type WalletPriceParseSource = "public_dom" | "popup_dom" | "unknown";

export type WalletParserResult = {
  nmId: number;
  url: string;
  region: string | null;
  priceRegular: number | null;
  /** Цена со скидкой продавца на витрине (если отличима от кошелька) */
  discountedPrice: number | null;
  priceWallet: number | null;
  /** Отладочные строки, собранные из DOM (могут отсутствовать). */
  lines?: string[];
  walletLabel: string | null;
  walletDiscountText: string | null;
  inStock: boolean | null;
  parsedAt: string;
  source: "dom";
  parseStatus: WalletParseStatus;
  /** 0..1 */
  sourceConfidence: number;
  parseMethod: string;
  /**
   * Итоговая витринная цена для СПП (приоритет: DOM страницы, затем card.wb.ru при отсутствии regular в DOM).
   */
  showcaseRubEffective?: number | null;
  showcaseResolvedSource?: "product_page_dom" | "card_api" | "none";
  /** Значение с card.wb.ru, если API дал число (диагностика). */
  showcaseApiRub?: number | null;
  /** Цена WB Кошелька из card.wb.ru, если поле присутствует в ответе. */
  apiWalletRub?: number | null;
  showcaseResolutionNote?: string | null;
  /** @deprecated Используйте showcaseApiRub; оставлено для совместимости с detailJson/клиентами */
  showcaseRubFromCookies?: number | null;
  /** Старая цена на витрине (productLinePriceOld). Не участвует в расчетах. */
  oldPriceRub?: number | null;
  /** HTML блока цены (для артефактов/forensic; может отсутствовать). */
  priceBlockHtml?: string;
  /** Признак наличия иконки кошелька рядом с ценой (если удалось извлечь). */
  walletIconDetected?: boolean;
  /** Wallet-specific кандидат цены (productLinePriceWallet). */
  showcaseWalletPriceCandidate?: number | null;
  /** Первая видимая строка цены после открытия карточки (debug/forensic). */
  firstVisiblePriceText?: string | null;
  /** Принятая из DOM цена кошелька до source-orchestrator. */
  walletPriceRubAcceptedFromDom?: number | null;
  /** Фактический URL вкладки после парсинга (SPA может убрать `dest` из query). */
  browserUrlAfterParse?: string | null;
  /** `dest` в запросах card.wb.ru для витрины на этом шаге (склад WB). */
  showcaseQueryDest?: string | null;
  /** Диагностика card.wb.ru — не подтверждает buyer-facing без VERIFIED. */
  cardApiShowcaseRub?: number | null;
  cardApiWalletRub?: number | null;
  showcaseRubFromCardApi?: number | null;
  showcaseRubFromDom?: number | null;
  showcasePriceRub?: number | null;
  priceWithSppWithoutWalletRub?: number | null;
  /** Уточнённая причина блока / сбоя (PUBLIC parse). */
  blockReason?: PublicParseBlockReason | null;
  pageTitle?: string | null;
  /** Первые ~4KB текста body для диагностики. */
  pageTextSnippet?: string | null;
  debugArtifactPaths?: string[];
  attemptCount?: number;
  /** HTTP статус ответа документа последней goto на карточку. */
  mainResponseHttpStatus?: number | null;
  verificationMethod?: "dom_wallet" | "unverified";
  verificationStatus?: "VERIFIED" | "UNVERIFIED";
  verificationReason?: string;
  verificationSource?: "dom_buybox" | "product_page_wallet_selector" | "card_api" | "none";
  sourcePriority?: string;
  sourceConflictDetected?: boolean;
  sourceConflictDeltaRub?: number | null;
  conflictAcceptedSource?: "local_verified" | "card_api" | "none";
  buyerPriceVerification?: BuyerPriceVerificationSnapshot;

  /** URL/nmId совпали с ожидаемыми (формально dest применён). */
  destApplied?: boolean;
  /** Есть реальный сигнал, что регион применился (не только URL). */
  regionConfirmed?: boolean;
  /** URL обновился, но сигналов применения региона нет. */
  destAppliedButNotConfirmed?: boolean;
  /** Маркер локации/доставки на странице (если удалось извлечь). */
  locationMarker?: string | null;
  /** Сигнатура price block (для отладки изменения при гидратации). */
  priceBlockSignature?: string | null;
  /** Попап «Детализация цены» открылся (для подтверждения региона). */
  popupOpened?: boolean;
  /** Цена «с WB Кошельком» из попапа (если распарсили). */
  popupWalletRub?: number | null;
  /** Цена «без WB Кошелька» из попапа (если распарсили). */
  popupWithoutWalletRub?: number | null;
  /** Неоднозначность региональной цены выявлена после batch-сравнения dest. */
  regionPriceAmbiguous?: boolean;
  /** Регион подтверждён по DOM-сигналам (маркер/перерисовка/попап). */
  regionDomConfirmed?: boolean;
  /** Регион подтверждён по факту успешного запроса/URL (nmId+dest). */
  regionConfirmedByRequest?: boolean;
  /** Регион подтверждён стабильным повторным чтением после reload в том же dest. */
  regionConfirmedByStableReload?: boolean;
  /** Первое чтение wallet в шаге (до retry). */
  walletPriceFirstRead?: number | null;
  /** Второе чтение wallet после hard reload в том же dest. */
  walletPriceSecondRead?: number | null;
  /** Финальная уверенность подтверждения региона. */
  finalRegionConfidence?: "HIGH" | "MEDIUM" | "LOW";
  /** Финальная уверенность сигнала кошелька. */
  finalWalletConfidence?: "HIGH" | "MEDIUM" | "LOW";
  /** Источник итогового решения repricing в шаге. */
  repricingDecisionSource?: string;
  /** Слой стратегии (batch): публичная витрина, popup детализации или card/cookies. */
  priceParseSource?: WalletPriceParseSource;
};

type ParseArtifacts = {
  htmlPath: string;
  screenshotPath: string;
  networkPath: string;
};

const KEYWORD_RE = /(wallet|loyalty|price|card|detail)/i;
const CURRENCY_RE = /(\d[\d\s\u00A0]*(?:[.,]\d{1,2})?)\s*(?:₽|руб)/giu;

/** Строка текста похожа на цену "с WB Кошельком" (не баланс кошелька). */
const WALLET_LINE_HINT =
  /(с\s*(wb\s*)?кошел|wb\s*кошел|кошельком|для\s*(wb\s*)?кошел|оплат[аы]\s*(wb\s*)?кошел|wallet)/i;
/** Явные маркеры строки баланса/кошелька аккаунта, а не цены товара. */
const WALLET_BALANCE_LINE_RE =
  /(баланс|доступн|начисл|списан|wb\s*club|клуба|сертификат|ресейл|travel|wibes)/i;

function isWalletPriceContextLine(line: string): boolean {
  return WALLET_LINE_HINT.test(line) && !WALLET_BALANCE_LINE_RE.test(line);
}

function mergeAdjacentWalletLines(lines: string[]): string[] {
  const extra: string[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const cur = lines[i]!;
    const next = lines[i + 1]!;
    if (isWalletPriceContextLine(cur) && !/(₽|руб)/i.test(cur) && /(₽|руб)/i.test(next)) {
      extra.push(`${cur} ${next}`.replace(/\s+/g, " ").trim());
    }
  }
  return extra;
}

/** Как в официальных ссылках WB на карточку — без этого SPA иногда не поднимает блок цен. */
const WB_DETAIL_TARGET_URL = "GP";

function applyWbDetailCanonicalParams(u: URL, dest: string | undefined): void {
  if (/\/catalog\/\d+\//i.test(u.pathname) && /detail\.aspx/i.test(u.pathname)) {
    if (!u.searchParams.has("targetUrl")) {
      u.searchParams.set("targetUrl", WB_DETAIL_TARGET_URL);
    }
  }
  if (dest) {
    u.searchParams.set("dest", dest);
  }
}

function ensureUrl(input: WalletParserInput): { url: string; nmId: number } {
  const dest = input.region?.trim();
  if (input.url) {
    const u = new URL(input.url);
    const match = u.pathname.match(/\/catalog\/(\d+)\//);
    if (!match) {
      throw new Error(`Cannot parse nmId from url: ${input.url}`);
    }
    applyWbDetailCanonicalParams(u, dest);
    return { url: u.toString(), nmId: Number(match[1]) };
  }
  if (input.nmId) {
    const u = new URL(`https://www.wildberries.ru/catalog/${input.nmId}/detail.aspx`);
    applyWbDetailCanonicalParams(u, dest);
    return { url: u.toString(), nmId: input.nmId };
  }
  throw new Error("Either url or nmId must be provided");
}

function parseRubValue(raw: string): number | null {
  const normalized = raw.replace(/\u00A0/g, " ").replace(/\s+/g, "").replace(",", ".");
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

function firstPriceFromText(text: string): number | null {
  const m = [...text.matchAll(CURRENCY_RE)];
  if (!m.length) {
    return null;
  }
  for (const mm of m) {
    const val = parseRubValue(mm[1]);
    if (val !== null) {
      return val;
    }
  }
  return null;
}

/** Подсказки цен из JSON-LD (часто есть offers.price) — усиливаем уверенность, не подменяем кошелёк. */
async function extractJsonLdPriceHints(page: Page): Promise<{ offer?: number; aggregate?: number }> {
  return page.evaluate(() => {
    const out: { offer?: number; aggregate?: number } = {};
    function parseNum(v: unknown): number | undefined {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim()) {
        const n = Number.parseFloat(v.replace(/\s/g, "").replace(",", "."));
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    function visit(node: unknown): void {
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      const t = o["@type"];
      const types = Array.isArray(t) ? t : t ? [t] : [];
      if (types.some((x) => String(x).toLowerCase() === "product")) {
        const offers = o.offers;
        const off = Array.isArray(offers) ? offers[0] : offers;
        if (off && typeof off === "object") {
          const price = parseNum((off as Record<string, unknown>).price);
          if (price != null && price > 0) {
            out.offer = price;
          }
        }
      }
      if (types.some((x) => String(x).toLowerCase() === "aggregateoffer")) {
        const low = parseNum(o.lowPrice);
        if (low != null && low > 0) {
          out.aggregate = low;
        }
      }
    }
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      const raw = (s.textContent || "").trim();
      if (!raw) continue;
      try {
        const j = JSON.parse(raw) as unknown;
        if (Array.isArray(j)) {
          for (const x of j) visit(x);
        } else {
          visit(j);
        }
      } catch {
        /* ignore */
      }
    }
    return out;
  });
}

function buildWalletResult(input: {
  nmId: number;
  url: string;
  region: string | null;
  dom: Awaited<ReturnType<typeof extractDomSignals>>;
  jsonHint: { offer?: number; aggregate?: number };
}): WalletParserResult {
  const { nmId, url, region, dom, jsonHint } = input;
  const jsonRef = jsonHint.offer ?? jsonHint.aggregate ?? null;
  let parseStatus: WalletParseStatus = "parse_failed";
  let sourceConfidence = 0.2;
  let parseMethod = "none";

  const walletCandidate =
    dom.walletIconDetected && dom.showcaseWalletPriceCandidate != null && dom.showcaseWalletPriceCandidate > 0
      ? dom.showcaseWalletPriceCandidate
      : dom.walletPrice != null && dom.walletPrice > 0
        ? dom.walletPrice
        : null;
  const hasWalletLine = walletCandidate != null;
  const hasRegular = dom.regularPrice != null && dom.regularPrice > 0;
  const walletFromRedLeftLayout =
    dom.walletDomHint === "red_left_spp_pair" &&
    Boolean(dom.walletLine?.includes("красная цена слева"));

  if (hasWalletLine) {
    parseStatus = "wallet_found";
    if (walletFromRedLeftLayout) {
      parseMethod = "wallet_red_left_spp_pair";
      sourceConfidence = 0.72;
    } else {
      parseMethod = "wallet_line+text_scan";
      sourceConfidence = 0.78;
    }
    if (jsonRef != null && Math.abs(jsonRef - walletCandidate) / jsonRef < 0.03) {
      sourceConfidence = Math.min(0.95, sourceConfidence + 0.12);
      parseMethod = walletFromRedLeftLayout
        ? "wallet_red_left_spp_pair+json_ld_confirm"
        : "wallet_line+json_ld_confirm";
    }
    if (walletCandidate != null && dom.regularPrice != null && walletCandidate < dom.regularPrice) {
      sourceConfidence = Math.min(0.93, sourceConfidence + 0.05);
    }
    if (dom.walletDomHint === "red_left_spp_pair" && !walletFromRedLeftLayout) {
      parseMethod = `${parseMethod};regular_from_spp_pair_layout`;
    }
  } else if (hasRegular) {
    const reg = dom.regularPrice!;
    parseStatus = "only_regular_found";
    parseMethod = "text_scan_regular";
    sourceConfidence = 0.55;
    if (jsonRef != null && Math.abs(jsonRef - reg) / jsonRef < 0.04) {
      sourceConfidence = Math.min(0.72, sourceConfidence + 0.1);
      parseMethod = "text_scan+json_ld";
    }
  } else if (jsonRef != null) {
    parseStatus = "only_regular_found";
    parseMethod = "json_ld_fallback";
    sourceConfidence = 0.42;
  }

  const priceRegular = dom.regularPrice ?? (jsonRef != null && !hasRegular ? jsonRef : null);

  let priceWalletResolved = hasWalletLine ? walletCandidate : null;
  if (
    priceWalletResolved != null &&
    dom.showcaseWalletPriceCandidate == null &&
    priceRegular != null &&
    Number.isFinite(priceRegular) &&
    priceRegular > 0 &&
    priceWalletResolved > priceRegular * 1.25
  ) {
    priceWalletResolved = null;
    if (parseStatus === "wallet_found") {
      parseStatus = "only_regular_found";
      sourceConfidence = Math.min(sourceConfidence, 0.58);
      parseMethod = `${parseMethod};wallet_rejected_gt_regular`;
    }
  }

  const discountedPrice =
    priceWalletResolved != null &&
    dom.regularPrice != null &&
    dom.regularPrice > priceWalletResolved
      ? dom.regularPrice
      : null;

  return {
    nmId,
    url,
    region,
    priceRegular,
    discountedPrice,
    priceWallet: priceWalletResolved,
    walletLabel: priceWalletResolved != null ? dom.walletLabel : null,
    walletDiscountText: priceWalletResolved != null ? dom.walletDiscountText : null,
    inStock: dom.inStock,
    parsedAt: new Date().toISOString(),
    source: "dom",
    parseStatus,
    sourceConfidence,
    parseMethod,
  };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

async function waitPriceReady(page: Page): Promise<void> {
  const selectors = [
    "[class*='price']",
    "[data-link*='price']",
    "[class*='product-page']",
    "[class*='wallet']",
    "body",
  ];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const s of selectors) {
      try {
        await page.waitForSelector(s, { timeout: 2500, state: "attached" });
      } catch {
        // continue trying broader selectors
      }
    }
    const bodyText = await page.innerText("body");
    if (/(₽|руб)/i.test(bodyText)) {
      return;
    }
    await page.waitForTimeout(1500);
  }
}

async function firstVisiblePriceText(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      function vis(el: HTMLElement): boolean {
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") return false;
        if (parseFloat(st.opacity || "1") < 0.08) return false;
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8 && r.bottom > -30 && r.top < window.innerHeight + 260;
      }
      function norm(s: string): string {
        return s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      }
      try {
        const meta = document.querySelector('meta[itemprop="price"][content]') as HTMLMetaElement | null;
        const mc = meta?.content?.trim();
        if (mc && /^\d/.test(mc)) {
          const num = mc.replace(/\s/g, "").replace(",", ".");
          return `${num} ₽`;
        }
      } catch {
        /* ignore */
      }
      try {
        const ip = document.querySelector("[itemprop=price], [itemprop=lowPrice]") as HTMLElement | null;
        if (ip && vis(ip)) {
          const t = norm(ip.innerText || "");
          if (/(₽|руб)/i.test(t) && t.length >= 2 && t.length <= 64) return t;
          const c = ip.getAttribute("content");
          if (c && /^\d/.test(c)) return `${c.replace(/\s/g, "").replace(",", ".")} ₽`;
        }
        const ins = document.querySelector(
          "ins.priceBlockFinalPrice, [class*='priceBlockFinalPrice'], [class*='productPrice']",
        ) as HTMLElement | null;
        if (ins && vis(ins)) {
          const t = norm(ins.innerText || "");
          if (/(₽|руб)/i.test(t) && t.length >= 2 && t.length <= 72) return t;
        }
      } catch {
        /* ignore */
      }
      const buyRoots = Array.from(document.querySelectorAll<HTMLElement>("div,section,aside"))
        .filter((el) => {
          if (!vis(el)) return false;
          const t = norm(el.innerText || "").toLowerCase();
          return /(добавить в корзину|купить сейчас|в корзину)/i.test(t);
        })
        .slice(0, 6);
      function collectPriceTexts(root: HTMLElement): string[] {
        return Array.from(root.querySelectorAll<HTMLElement>("span,div,p,b,strong,ins"))
          .filter((el) => vis(el))
          .map((el) => norm(el.innerText || ""))
          .filter(
            (t) =>
              /(₽|руб)/i.test(t) &&
              t.length >= 2 &&
              t.length <= 60 &&
              !/wibes|как бизнес|сертификат|баланс|кошел(ек|ёк)/i.test(t) &&
              !/\bRUB\b/i.test(t) &&
              !/^0\s+\d/i.test(t),
          );
      }
      for (const root of buyRoots) {
        const local = collectPriceTexts(root);
        if (local.length > 0) return local[0]!;
      }
      const fallback = Array.from(document.querySelectorAll<HTMLElement>("span,div,p,b,strong,ins"))
        .filter((el) => vis(el))
        .map((el) => norm(el.innerText || ""))
        .filter(
          (t) =>
            /(₽|руб)/i.test(t) &&
            t.length >= 2 &&
            t.length <= 48 &&
            !/wibes|как бизнес|сертификат|баланс|кошел(ек|ёк)/i.test(t) &&
            !/\bRUB\b/i.test(t) &&
            !/^0\s+\d/i.test(t),
        );
      return fallback[0] ?? null;
    })
    .catch(() => null);
}

function currentCardContext(pageUrl: string): { nmId: number | null; dest: string | null } {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/\/catalog\/(\d+)\//i);
    const nmId = m?.[1] ? Number.parseInt(m[1], 10) : null;
    const dest = u.searchParams.get("dest");
    return { nmId: Number.isFinite(nmId as number) ? nmId : null, dest: dest?.trim() || null };
  } catch {
    return { nmId: null, dest: null };
  }
}

function shortSig(s: string, max = 180): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function stableSignature(parts: { text?: string | null; html?: string | null; marker?: string | null }): string {
  const raw = JSON.stringify(
    {
      t: shortSig(parts.text ?? "", 800),
      m: shortSig(parts.marker ?? "", 240),
      h: shortSig(parts.html ?? "", 1200),
    },
    null,
    0,
  );
  // simple stable hash
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `sig_${(hash >>> 0).toString(16)}`;
}

async function extractLocationMarker(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      function visible(el: Element): boolean {
        const h = el as HTMLElement;
        const st = window.getComputedStyle(h);
        if (st.display === "none" || st.visibility === "hidden") return false;
        const r = h.getBoundingClientRect();
        return r.width > 2 && r.height > 2 && r.top < window.innerHeight + 400 && r.bottom > -100;
      }
      const candidates: string[] = [];
      for (const sel of [
        "[data-link*='Delivery']",
        "[data-link*='delivery']",
        "[data-link*='Address']",
        "[data-link*='address']",
        "[data-link*='Geo']",
        "[data-link*='geo']",
        "[aria-label*='достав' i]",
        "[aria-label*='адрес' i]",
        "[class*='delivery' i]",
        "[class*='address' i]",
      ]) {
        try {
          const els = Array.from(document.querySelectorAll(sel)).filter(visible);
          for (const el of els.slice(0, 8)) {
            const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
            if (t.length >= 3 && t.length <= 120) {
              candidates.push(t);
            }
          }
        } catch {
          /* ignore */
        }
      }
      const uniq = [...new Set(candidates)];
      return uniq[0] ?? null;
    })
    .catch(() => null);
}

async function tryOpenPriceDetailsPopup(page: Page): Promise<{
  popupOpened: boolean;
  walletRub: number | null;
  withoutWalletRub: number | null;
}> {
  const out: { popupOpened: boolean; walletRub: number | null; withoutWalletRub: number | null } =
    { popupOpened: false, walletRub: null, withoutWalletRub: null };
  let trigger = page.locator('[class*="productLinePriceWallet"]').first();
  let hasTrigger = (await trigger.count().catch(() => 0)) > 0;
  if (!hasTrigger) {
    trigger = page.locator('[class*="PriceWallet"][class*="product"], [data-link*="walletPrice"]').first();
    hasTrigger = (await trigger.count().catch(() => 0)) > 0;
  }
  if (!hasTrigger) return out;
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 2500 }).catch(() => {});
  const dialog = page.locator('[role="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]').first();
  const visible = await dialog.isVisible().catch(() => false);
  if (!visible) return out;
  const txt = await dialog.innerText().catch(() => "");
  const money = Array.from(txt.matchAll(/(\d[\d\s\u00A0]*)\s*₽/g)).map((m) =>
    Number.parseInt(String(m[1]).replace(/\s+/g, ""), 10),
  );
  const vals = money.filter((n) => Number.isFinite(n) && n > 0);
  if (vals.length < 2) {
    out.popupOpened = true;
    return out;
  }
  // label-based mapping if present
  const lines = txt.split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const walletLine = lines.find((l) => /(с\s*(wb\s*)?кошел|wb\s*кошел|кошельком)/i.test(l));
  const noWalletLine = lines.find((l) => /(без\s*(wb\s*)?кошел|без\s*кошельк)/i.test(l));
  const parseLine = (l?: string): number | null => {
    if (!l) return null;
    const m = l.match(/(\d[\d\s\u00A0]*)\s*₽/);
    if (!m) return null;
    const n = Number.parseInt(String(m[1]).replace(/\s+/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = parseLine(walletLine ?? undefined);
  const nw = parseLine(noWalletLine ?? undefined);
  if (w != null && nw != null) {
    out.popupOpened = true;
    out.walletRub = w;
    out.withoutWalletRub = nw;
    await page.keyboard.press("Escape").catch(() => {});
    return out;
  }
  // numeric heuristic: min = wallet, max = without-wallet
  out.popupOpened = true;
  out.walletRub = Math.min(...vals);
  out.withoutWalletRub = Math.max(...vals);
  // try to close to avoid blocking next steps
  await page.keyboard.press("Escape").catch(() => {});
  return out;
}

async function confirmDestApplied(input: {
  page: Page;
  expectedNmId: number;
  expectedDest: string | null;
  prevLocationMarker: string | null;
  prevPriceBlockSignature: string | null;
  currentLocationMarker: string | null;
  currentPriceBlockSignature: string | null;
  popupOpened: boolean;
  popupWalletRub: number | null;
  popupWithoutWalletRub: number | null;
  stableReloadConfirmed?: boolean;
}): Promise<{
  destInUrl: string | null;
  destApplied: boolean;
  regionConfirmed: boolean;
  regionDomConfirmed: boolean;
  regionConfirmedByRequest: boolean;
  regionConfirmedByStableReload: boolean;
  destAppliedButNotConfirmed: boolean;
  signals: string[];
}> {
  const ctx = currentCardContext(input.page.url());
  const destInUrl = ctx.dest;
  const nmOk = ctx.nmId != null && ctx.nmId === input.expectedNmId;
  const destOk =
    input.expectedDest == null || input.expectedDest.trim().length === 0
      ? true
      : destInUrl != null && destInUrl === input.expectedDest;
  const destApplied = nmOk && destOk;

  const signals: string[] = [];
  const locationChanged =
    input.prevLocationMarker != null &&
    input.currentLocationMarker != null &&
    input.prevLocationMarker !== input.currentLocationMarker;
  if (locationChanged) signals.push("location_marker_changed");

  const priceBlockChanged =
    input.prevPriceBlockSignature != null &&
    input.currentPriceBlockSignature != null &&
    input.prevPriceBlockSignature !== input.currentPriceBlockSignature;
  if (priceBlockChanged) signals.push("price_block_signature_changed");

  const popupParsed =
    input.popupOpened &&
    input.popupWalletRub != null &&
    input.popupWithoutWalletRub != null &&
    input.popupWalletRub > 0 &&
    input.popupWithoutWalletRub > 0;
  if (popupParsed) signals.push("popup_prices_parsed");

  const regionDomConfirmed = locationChanged || priceBlockChanged || popupParsed;
  const regionConfirmedByRequest = destApplied;
  const regionConfirmedByStableReload = input.stableReloadConfirmed === true;
  const regionConfirmed =
    regionDomConfirmed || regionConfirmedByRequest || regionConfirmedByStableReload;
  const destAppliedButNotConfirmed = destApplied && !regionConfirmed;
  return {
    destInUrl,
    destApplied,
    regionConfirmed,
    regionDomConfirmed,
    regionConfirmedByRequest,
    regionConfirmedByStableReload,
    destAppliedButNotConfirmed,
    signals,
  };
}

async function readWalletAfterHardReload(input: {
  page: Page;
  parserInput: WalletParserInput;
  resolved: ResolvedBrowser;
}): Promise<{ walletRub: number | null; firstVisibleText: string | null }> {
  const { page, parserInput, resolved } = input;
  const { url } = ensureUrl(parserInput);
  const nav = await gotoVerified(page, url, resolved.label, "region-stability-reload");
  if (!nav.ok) return { walletRub: null, firstVisibleText: null };
  await waitPriceReady(page);
  const firstVisibleText = await firstVisiblePriceText(page);
  const dom = await extractDomSignals(page);
  const walletRub =
    dom.walletIconDetected === true &&
    dom.showcaseWalletPriceCandidate != null &&
    dom.showcaseWalletPriceCandidate > 0
      ? Math.round(dom.showcaseWalletPriceCandidate)
      : dom.walletPrice != null && dom.walletPrice > 0
        ? Math.round(dom.walletPrice)
        : null;
  return { walletRub, firstVisibleText };
}

type WalletScreenshotOcrResult = {
  method: "screenshot_ocr";
  walletDetected: boolean;
  extractedText: string;
  parsedPrice: number | null;
};

function parseDigitsPrice(text: string): number | null {
  const onlyDigits = text.replace(/[^\d]/g, "");
  if (!onlyDigits) return null;
  const n = Number.parseInt(onlyDigits, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 10 || n > 50_000_000) return null;
  return n;
}

async function tryWalletPriceViaScreenshotOcr(
  page: Page,
  nmId: number,
): Promise<WalletScreenshotOcrResult> {
  const result: WalletScreenshotOcrResult = {
    method: "screenshot_ocr",
    walletDetected: false,
    extractedText: "",
    parsedPrice: null,
  };

  const blockLocator = page
    .locator(
      [
        "[class*='productLine']",
        "[class*='price'][class*='line' i]",
        "[class*='buy'][class*='block' i]",
        "[data-link*='Price']",
      ].join(","),
    )
    .first();

  const blockBox = await blockLocator.boundingBox().catch(() => null);
  if (!blockBox || blockBox.width < 20 || blockBox.height < 20) {
    return result;
  }

  const iconLocator = blockLocator
    .locator(
      [
        "[class*='wallet' i]",
        "[data-link*='wallet' i]",
        "[aria-label*='кошел' i]",
        "img[alt*='кошел' i]",
        "svg[class*='wallet' i]",
      ].join(","),
    )
    .first();
  const iconBox = await iconLocator.boundingBox().catch(() => null);
  if (!iconBox || iconBox.width < 2 || iconBox.height < 2) {
    return result;
  }
  result.walletDetected = true;

  const artifactsDir = walletArtifactsDir();
  await fsp.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  const ts = Date.now();
  const blockPath = path.join(artifactsDir, `${nmId}-${ts}-wallet-block.png`);
  const roiPath = path.join(artifactsDir, `${nmId}-${ts}-wallet-ocr-roi.png`);

  await page
    .screenshot({
      path: blockPath,
      fullPage: false,
      clip: {
        x: Math.max(0, blockBox.x),
        y: Math.max(0, blockBox.y),
        width: Math.max(1, Math.min(blockBox.width, Math.max(1, page.viewportSize()?.width ?? 1920))),
        height: Math.max(1, Math.min(blockBox.height, Math.max(1, page.viewportSize()?.height ?? 1080))),
      },
    })
    .catch(() => {});

  const roiX = iconBox.x + iconBox.width + 6;
  const roiY = Math.max(blockBox.y, iconBox.y - 8);
  const roiWidth = Math.min(250, Math.max(150, blockBox.x + blockBox.width - roiX));
  const roiHeight = Math.min(
    Math.max(44, iconBox.height + 16),
    Math.max(24, blockBox.y + blockBox.height - roiY),
  );

  if (roiWidth < 40 || roiHeight < 20) {
    return result;
  }

  await page
    .screenshot({
      path: roiPath,
      fullPage: false,
      clip: {
        x: Math.max(0, roiX),
        y: Math.max(0, roiY),
        width: Math.max(1, roiWidth),
        height: Math.max(1, roiHeight),
      },
    })
    .catch(() => {});

  try {
    const { stdout } = await execFileAsync("tesseract", [
      roiPath,
      "stdout",
      "--psm",
      "7",
      "-c",
      "tessedit_char_whitelist=0123456789",
    ]);
    const txt = String(stdout ?? "").replace(/\s+/g, " ").trim();
    result.extractedText = txt;
    result.parsedPrice = parseDigitsPrice(txt);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tag: "wb-wallet-ocr", nmId, err: msg }, "wallet screenshot OCR failed");
    return result;
  }
}

async function extractDomSignals(page: Page): Promise<{
  lines: string[];
  walletLine: string | null;
  walletLabel: string | null;
  walletDiscountText: string | null;
  regularPrice: number | null;
  buyBlockRegularRub: number | null;
  walletPrice: number | null;
  oldPriceRub: number | null;
  inStock: boolean | null;
  priceBlockHtml: string;
  /** Кошелёк распознан по красной цене слева от цены со СПП (без текста «кошелёк»). */
  walletDomHint: "red_left_spp_pair" | null;
  /** Иконка/маркер кошелька в зоне покупки (рядом с CTA). */
  walletIconDetected: boolean;
  /** Витринная цена «с WB кошельком» (productLinePriceWallet). Единственный источник истины для walletPriceRub. */
  showcaseWalletPriceCandidate: number | null;
}> {
  const payload = await page.evaluate(() => {
    function parseLeafRub(raw: string): number | null {
      const s = raw.replace(/\u00A0/g, " ").trim();
      const m = s.match(/^(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?)\s*$/i);
      if (!m) return null;
      const n = Number.parseFloat(m[1]!.replace(/\s+/g, "").replace(",", "."));
      if (!Number.isFinite(n) || n < 10 || n > 50_000_000) return null;
      return Math.round(n);
    }

    function isVisibleEl(el: HTMLElement): boolean {
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      if (parseFloat(st.opacity || "1") < 0.1) return false;
      const r = el.getBoundingClientRect();
      return r.width > 6 && r.height > 6;
    }
    let walletFromClass: number | null = null;
    let oldFromClass: number | null = null;
    function parseHintRub(raw: string | null | undefined): number | null {
      if (raw == null || !String(raw).trim()) return null;
      const n = Number.parseFloat(
        String(raw).replace(/\u00A0/g, " ").replace(/\s+/g, "").replace(",", "."),
      );
      if (!Number.isFinite(n) || n < 10 || n > 50_000_000) return null;
      return Math.round(n);
    }
    const semanticHints: number[] = [];
    function pushHint(raw: string | null | undefined): void {
      const v = parseHintRub(raw);
      if (v != null) {
        semanticHints.push(v);
      }
    }
    for (const sel of [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[itemprop="price"]',
    ]) {
      document.querySelectorAll(sel).forEach((el) => {
        pushHint(el.getAttribute("content"));
      });
    }
    document.querySelectorAll('[itemprop="price"]').forEach((el) => {
      pushHint(el.getAttribute("content"));
      pushHint((el.textContent || "").trim());
    });

    const baseSelectors = [
      "[class*='price']",
      "[data-link*='Price']",
      "[data-link*='price']",
      "[class*='wallet']",
      "[class*='Wallet']",
      "[class*='product-page']",
      "[class*='buy']",
      "[class*='sale']",
      "[class*='cost']",
    ];
    let candidates = Array.from(
      document.querySelectorAll(baseSelectors.join(",")),
    ) as HTMLElement[];
    const seen = new Set(candidates);
    const walletExtraSels = [
      "[data-link*='wallet']",
      "[data-link*='Wallet']",
      "[data-testid*='wallet']",
      "[data-testid*='Wallet']",
      "[data-test-id*='wallet']",
      "[aria-label*='кошел']",
      "[aria-label*='Кошел']",
      "[aria-label*='Wallet']",
    ];
    for (const sel of walletExtraSels) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          const h = el as HTMLElement;
          if (!seen.has(h)) {
            seen.add(h);
            candidates.push(h);
          }
        });
      } catch (_e) {
        /* ignore invalid selector */
      }
    }
    const visible = candidates.filter((el) => {
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const chunks = visible.map((el) => ({
      text: (el.innerText || "").trim(),
      html: (el.innerHTML || "").trim(),
    }));
    const lines = chunks
      .flatMap((x) => x.text.split("\n"))
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => x.length < 250);
    const hasExplicitWalletMarker = lines.some((x) =>
      /(с\s*(wb\s*)?кошел|без\s*(wb\s*)?кошел|(wb\s*)?кошельком|wallet)/i.test(x),
    );

    // parseLeafRub defined above (used for strict class-based wallet/old extraction)
    function rgbFromCssColor(c: string): [number, number, number] | null {
      const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    function isReddish(rgb: [number, number, number]): boolean {
      const [r, g, b] = rgb;
      return r >= 130 && r > g + 18 && r > b + 12;
    }
    const buyTexts = /(добавить в корзину|в корзину|купить сейчас)/i;
    const buyAnchors = Array.from(document.querySelectorAll("button, a, div, span")).filter((n) => {
      const el = n as HTMLElement;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!buyTexts.test(t)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 12 && r.bottom > -40 && r.top < window.innerHeight + 420;
    }) as HTMLElement[];
    const anchorRects = buyAnchors.map((a) => a.getBoundingClientRect());
    function nearBuyZone(x: number, y: number): boolean {
      return anchorRects.some((r) => x - r.left >= -280 && x - r.left <= 520 && y - r.top >= -300 && y - r.top <= 240);
    }
    function pickPriceFromClassScoped(classPart: string, requireNearBuy: boolean): number | null {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[class*="${classPart}"]`));
      for (const el of nodes) {
        if (!isVisibleEl(el)) continue;
        const br = el.getBoundingClientRect();
        if (requireNearBuy && !nearBuyZone(br.left + br.width / 2, br.top + br.height / 2)) continue;
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        // Balance-like tokens are not product wallet price.
        if (/\bRUB\b/i.test(t) || /^0\s+\d/i.test(t) || /баланс/i.test(t)) continue;
        const m = t.match(/(\d[\d\s\u00A0]*(?:[.,]\d{1,2})?)\s*(?:₽|руб)/i);
        if (!m) continue;
        const v = parseLeafRub(`${m[1]} ₽`);
        if (v != null) return v;
      }
      return null;
    }
    walletFromClass =
      pickPriceFromClassScoped("productLinePriceWallet", true) ??
      pickPriceFromClassScoped("productLinePriceWallet", false);
    oldFromClass =
      pickPriceFromClassScoped("productLinePriceOld", true) ??
      pickPriceFromClassScoped("productLinePriceOld", false);

    type Pcand = {
      el: HTMLElement;
      rub: number;
      left: number;
      top: number;
      reddish: boolean;
    };
    const priceCandidates: Pcand[] = [];
    for (const node of document.querySelectorAll(
      "span, div, ins, p, h1, h2, h3, b, strong, i",
    )) {
      const el = node as HTMLElement;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      if (parseFloat(st.opacity || "1") < 0.15) continue;
      const subs = el.querySelectorAll("*");
      let childHasCurrency = false;
      for (let i = 0; i < subs.length; i += 1) {
        const ct = (subs[i]!.textContent || "").trim();
        if (ct.length > 0 && ct.length < 48 && /(₽|руб)/i.test(ct)) {
          childHasCurrency = true;
          break;
        }
      }
      if (childHasCurrency) continue;
      const txt = (el.innerText || "").replace(/\u00A0/g, " ").trim();
      if (txt.length < 5 || txt.length > 40) continue;
      if (!/(₽|руб)/i.test(txt)) continue;
      if (/отзыв|корзин|доставк|продав|\d+\s*шт|cashback|кэшбэк/i.test(txt)) continue;
      const rub = parseLeafRub(txt);
      if (rub == null) continue;
      const br = el.getBoundingClientRect();
      if (br.width < 1 || br.height < 1 || br.bottom < -80 || br.top > window.innerHeight + 500) {
        continue;
      }
      const rgb = rgbFromCssColor(st.color);
      const reddish = rgb != null && isReddish(rgb);
      priceCandidates.push({ el, rub, left: br.left, top: br.top, reddish });
    }

    let redLeftWalletRub: number | null = null;
    let pairRightRub: number | null = null;
    let redLeftPairNearBuy = false;
    const byParent = new Map<HTMLElement, Pcand[]>();
    for (const c of priceCandidates) {
      const p = c.el.parentElement;
      if (!p) continue;
      const arr = byParent.get(p) ?? [];
      arr.push(c);
      byParent.set(p, arr);
    }
    const groups = [...byParent.values()].filter((a) => a.length >= 2);
    groups.sort(
      (a, b) =>
        Math.min(...a.map((x) => x.top)) - Math.min(...b.map((x) => x.top)),
    );
    for (const arr of groups) {
      const uniq: Pcand[] = [];
      for (const c of arr) {
        if (!uniq.some((u) => u.rub === c.rub && Math.abs(u.left - c.left) < 8)) {
          uniq.push(c);
        }
      }
      if (uniq.length < 2) continue;
      uniq.sort((a, b) => a.left - b.left);
      const left = uniq[0]!;
      const right = uniq[uniq.length - 1]!;
      if (left.el === right.el || left.rub === right.rub) continue;
      if (left.reddish && !right.reddish) {
        redLeftPairNearBuy = nearBuyZone(left.left, left.top) || nearBuyZone(right.left, right.top);
        redLeftWalletRub = left.rub;
        pairRightRub = right.rub;
        break;
      }
      if (left.reddish && left.rub < right.rub) {
        redLeftPairNearBuy = nearBuyZone(left.left, left.top) || nearBuyZone(right.left, right.top);
        redLeftWalletRub = left.rub;
        pairRightRub = right.rub;
        break;
      }
    }

    // Приоритетно пробуем взять regular из зоны покупки (рядом с CTA),
    // чтобы не схватить шумные цены из шапки/меню ("Ресейл 315 ₽" и т.п.).
    const noiseAroundPrice = /(частями|платеж|без переплат|оценк|вопрос|клуб|сертификат|ресейл|travel|wibes)/i;
    const nearBuyCandidates = priceCandidates.filter((c) => {
      const txt = (c.el.innerText || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
      if (!txt || txt.length > 80) return false;
      if (noiseAroundPrice.test(txt)) return false;
      if (/(^|[^\d])0\s*(₽|руб)/i.test(txt)) return false;
      return nearBuyZone(c.left, c.top);
    });
    const pool = nearBuyCandidates.some((c) => !c.reddish)
      ? nearBuyCandidates.filter((c) => !c.reddish)
      : nearBuyCandidates;
    const sortedVals = [...new Set(pool.map((c) => c.rub))].sort((a, b) => a - b);
    let buyBlockRegularRub: number | null = sortedVals[0] ?? null;
    if (sortedVals.length >= 2 && buyBlockRegularRub != null) {
      const second = sortedVals[1]!;
      // Отсекаем подозрительно маленький выброс в зоне покупки (частый кейс 315 ₽).
      if (buyBlockRegularRub < 900 && second >= buyBlockRegularRub * 1.8) {
        buyBlockRegularRub = second;
      }
    }

    const walletIconSelectors = [
      '[class*="wallet" i]',
      '[class*="Wallet"]',
      '[data-link*="wallet" i]',
      '[data-link*="Wallet"]',
      '[aria-label*="кошел" i]',
      '[aria-label*="Кошел" i]',
      'img[alt*="кошел" i]',
    ];
    let walletIconDetected = Boolean(hasExplicitWalletMarker);
    if (!walletIconDetected) {
      for (const sel of walletIconSelectors) {
        let nodes: NodeListOf<Element>;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const n of Array.from(nodes)) {
          const el = n as HTMLElement;
          const st = window.getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          if (!nearBuyZone(r.left + r.width / 2, r.top + r.height / 2)) continue;
          walletIconDetected = true;
          break;
        }
        if (walletIconDetected) break;
      }
    }

    // Единственный источник истины для витрины кошелька:
    // - productLinePriceWallet, без fallback на "первую/вторую цену" или цветовые эвристики.
    const showcaseWalletPriceCandidate: number | null = walletFromClass;

    const priceBlockNodes = Array.from(
      document.querySelectorAll<HTMLElement>("[class*='productLine'], [class*='price'], [data-link*='Price']"),
    );
    const priceBlockTexts = priceBlockNodes.map((el) => (el.innerText || "").trim()).join("\n");

    const priceNodesDebug: {
      index: number;
      tagName: string;
      className: string;
      innerText: string;
      outerHTML: string;
      parsedNumber: number | null;
    }[] = [];
    function parseLeafRubDebug(raw: string): number | null {
      const s = raw.replace(/\u00A0/g, " ").trim();
      const m = s.match(/^(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?)\s*$/i);
      if (!m) return null;
      const n = Number.parseFloat(m[1]!.replace(/\s+/g, "").replace(",", "."));
      if (!Number.isFinite(n) || n < 10 || n > 50_000_000) return null;
      return Math.round(n);
    }
    const priceNodesAll = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) =>
      /(₽|руб)/i.test(el.innerText || ""),
    );
    priceNodesAll.forEach((el, idx) => {
      const txt = (el.innerText || "").trim();
      const shortHtml = (el.outerHTML || "").slice(0, 640);
      priceNodesDebug.push({
        index: idx,
        tagName: el.tagName,
        className: el.className,
        innerText: txt,
        outerHTML: shortHtml,
        parsedNumber: parseLeafRubDebug(txt),
      });
    });

    return {
      lines: Array.from(new Set(lines)),
      blockHtml: chunks.map((x) => x.html).join("\n"),
      bodyText: (document.body?.innerText || "").trim(),
      semanticHints: [...new Set(semanticHints)],
      redLeftWalletRub,
      pairRightRub,
      buyBlockRegularRub,
      hasExplicitWalletMarker,
      redLeftPairNearBuy,
      walletIconDetected,
      showcaseWalletPriceCandidate,
      oldFromClass,
      priceBlockTexts,
      priceNodesDebug,
    };
  });

  const lines = dedupe(payload.lines);
  const mergedWallet = dedupe(mergeAdjacentWalletLines(lines));
  const searchLines = dedupe([...mergedWallet, ...lines]);
  const walletPricedLines = searchLines.filter(
    (x) => isWalletPriceContextLine(x) && /(₽|руб)/i.test(x),
  );
  const walletContextLines = searchLines.filter((x) => isWalletPriceContextLine(x));
  let walletLine =
    walletPricedLines[0] ||
    walletContextLines[0] ||
    null;

  let walletPrice = walletLine ? firstPriceFromText(walletLine) : null;
  const redLeft = payload.redLeftWalletRub as number | null | undefined;
  const pairRight = payload.pairRightRub as number | null | undefined;
  let walletDomHint: "red_left_spp_pair" | null = null;
  if (
    redLeft != null &&
    pairRight != null &&
    redLeft > 0 &&
    pairRight > 0 &&
    redLeft !== pairRight
  ) {
    walletDomHint = "red_left_spp_pair";
    if (walletPrice == null && (payload.hasExplicitWalletMarker || payload.redLeftPairNearBuy)) {
      walletPrice = redLeft;
      walletLine = "WB Кошелёк (красная цена слева от цены со СПП)";
    }
  }
  const walletLabelResolved =
    walletLine != null ? walletLine.replace(/\s+/g, " ").trim() : null;
  const walletDiscountTextResolved =
    (walletLine && walletLine.match(/-\s*\d+(?:[.,]\d+)?\s*%/)?.[0]) ||
    walletContextLines.find((x) => /-\s*\d+(?:[.,]\d+)?\s*%/.test(x)) ||
    null;

  let regularPrice: number | null = payload.buyBlockRegularRub ?? null;
  for (const line of searchLines) {
    if (regularPrice != null) {
      break;
    }
    if (isWalletPriceContextLine(line)) {
      continue;
    }
    const price = firstPriceFromText(line);
    if (price !== null) {
      regularPrice = price;
      break;
    }
  }
  // If only one visible price exists on page, treat it as regular only.
  if (regularPrice === null) {
    regularPrice = firstPriceFromText(payload.bodyText);
  }
  if (regularPrice === null && payload.semanticHints.length > 0) {
    regularPrice = Math.max(...payload.semanticHints);
  }
  if (walletDomHint != null && pairRight != null) {
    regularPrice = pairRight;
  }
  const inStock = /нет в наличии/i.test(payload.bodyText)
    ? false
    : /(добавить в корзину|купить сейчас|в корзину)/i.test(payload.bodyText)
      ? true
      : null;

  return {
    lines,
    walletLine,
    walletLabel: walletLabelResolved,
    walletDiscountText: walletDiscountTextResolved,
    regularPrice,
    buyBlockRegularRub: payload.buyBlockRegularRub ?? null,
    walletPrice,
    oldPriceRub:
      typeof payload.oldFromClass === "number" &&
      Number.isFinite(payload.oldFromClass) &&
      payload.oldFromClass > 0
        ? Math.round(payload.oldFromClass)
        : null,
    inStock,
    priceBlockHtml: payload.blockHtml || "",
    walletDomHint,
    walletIconDetected: Boolean(payload.walletIconDetected),
    showcaseWalletPriceCandidate:
      typeof payload.showcaseWalletPriceCandidate === "number" &&
      Number.isFinite(payload.showcaseWalletPriceCandidate) &&
      payload.showcaseWalletPriceCandidate > 0
        ? Math.round(payload.showcaseWalletPriceCandidate)
        : null,
  };
}

async function saveArtifacts(
  page: Page,
  nmId: number,
  lines: string[],
  priceBlockHtml: string,
  networkUrls: string[],
): Promise<ParseArtifacts> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = walletArtifactsDir();
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  await maybePruneWalletArtifacts(dir).catch(() => {});
  const htmlPath = path.join(dir, `${nmId}-${ts}-price-block.html`);
  const screenshotPath = path.join(dir, `${nmId}-${ts}-page.png`);
  const networkPath = path.join(dir, `${nmId}-${ts}-network.json`);

  await fsp
    .writeFile(
      htmlPath,
      `<!-- extracted lines -->\n${lines.map((x) => `<div>${x}</div>`).join("\n")}\n<!-- block html -->\n${priceBlockHtml}`,
      "utf8",
    )
    .catch(() => {});
  await page
    .screenshot({ path: screenshotPath, fullPage: true, timeout: 8000 })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ tag: "wb-wallet-artifacts", nmId, err: msg }, "screenshot failed; continue without artifact");
    });
  await fsp
    .writeFile(networkPath, JSON.stringify({ urls: networkUrls }, null, 2), "utf8")
    .catch(() => {});

  return { htmlPath, screenshotPath, networkPath };
}

/** Любая версия cards/vN/detail на card.wb.ru (WB меняет v2/v4/v…). */
function isCardWbDetailCardsUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes("card.wb.ru") && /\/cards\/v\d+\/detail/i.test(u);
}

/** Та же карточка, но через внутренний endpoint на wildberries.ru (часто доступен в браузерном контексте). */
function isWbInternalCardDetailUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("wildberries.ru") &&
    /\/__internal\/card\/cards\/v\d+\/detail/i.test(u)
  );
}

async function readResponseBodyJson(res: Response): Promise<unknown | null> {
  try {
    const txt = await res.text();
    const t = txt.trim();
    if (!t || (!t.startsWith("{") && !t.startsWith("["))) {
      return null;
    }
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

/**
 * Ответы card.wb.ru, которые страница уже загрузила в браузере (часто 200),
 * в отличие от отдельного `APIRequestContext.get` → 403.
 */
function attachCardDetailResponseSniffer(
  page: Page,
  capturedCardBodies: unknown[],
  inflight: Promise<void>[],
): () => void {
  const handler = (res: Response) => {
    const u = res.url();
    const isCardLike =
      isCardWbDetailCardsUrl(u) ||
      isWbInternalCardDetailUrl(u);
    if (!isCardLike || res.status() !== 200) {
      return;
    }
    inflight.push(
      (async () => {
        const body = await readResponseBodyJson(res);
        if (body != null && capturedCardBodies.length < 16) {
          capturedCardBodies.push(body);
        }
      })(),
    );
  };
  page.on("response", handler);
  return () => page.off("response", handler);
}

function attachWalletNetworkCollectors(page: Page, networkUrls: Set<string>): void {
  page.on("request", (req) => {
    const u = req.url();
    const t = req.resourceType();
    if ((t === "xhr" || t === "fetch") && KEYWORD_RE.test(u)) {
      networkUrls.add(u);
    }
  });
  page.on("response", (res) => {
    const u = res.url();
    const t = res.request().resourceType();
    if ((t === "xhr" || t === "fetch") && KEYWORD_RE.test(u)) {
      networkUrls.add(u);
    }
  });
}

async function resolveRegionalShowcasePrice(input: {
  walletDom: WalletParserResult;
  page: Page;
  nmId: number;
  regionDest: string | null;
  fallbackDest: string | null;
  maxCardAttempts?: number;
  stockLevel: ReturnType<typeof resolveStockLevel>;
}): Promise<Awaited<ReturnType<typeof resolveShowcaseForMonitorStep>>> {
  return resolveShowcaseForMonitorStep({
    walletDom: input.walletDom,
    api: input.page.request,
    page: input.page,
    nmId: input.nmId,
    regionDest: input.regionDest,
    fallbackDest: input.fallbackDest,
    tryCardApi: true,
    maxCardAttempts: input.maxCardAttempts,
    stockLevel: input.stockLevel,
  });
}

function usePublicRuntimeConfig(input: WalletParserInput): boolean {
  return isPublicOnlyWalletParse() || input.applyPublicBrowserEnv === true;
}

/**
 * Одна карточка WB на уже открытой странице (браузер и контекст снаружи).
 */
async function scrapeWalletPriceOnPage(
  page: Page,
  input: WalletParserInput,
  resolved: ResolvedBrowser,
  networkUrls: Set<string>,
): Promise<WalletParserResult> {
  const { url, nmId } = ensureUrl(input);
  const requestedDest = input.region?.trim() ?? "";
  networkUrls.clear();
  let firstVisiblePriceTextRaw: string | null = null;
  let firstVisibleRub: number | null = null; // legacy debug only; not used as wallet truth

  const capturedCardBodies: unknown[] = [];
  const cardInflight: Promise<void>[] = [];
  const detachCardSniffer = attachCardDetailResponseSniffer(page, capturedCardBodies, cardInflight);
  const publicRuntime = usePublicRuntimeConfig(input);
  let lastDocHttpStatus: number | null = null;
  logger.info(
    {
      tag: "public_parse_started",
      nmId,
      url,
      publicRuntime,
      attemptIndex: input.attemptIndex ?? null,
    },
    "scrape wallet page started",
  );

  let lastErr: unknown = null;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await Promise.allSettled(cardInflight);
      cardInflight.length = 0;
      capturedCardBodies.length = 0;
      try {
        const nav = await gotoVerified(page, url, resolved.label, `product-${attempt}`);
        lastDocHttpStatus = nav.httpStatus;
        if (!nav.ok) {
          lastErr = new Error("product page has no body text after domcontentloaded+price-ready wait");
          if (attempt === 2) {
            throw lastErr;
          }
          continue;
        }
        await waitPriceReady(page);
        const ctx = currentCardContext(page.url());
        const firstPrice = await firstVisiblePriceText(page);
        firstVisiblePriceTextRaw = firstPrice;
        firstVisibleRub = firstPrice != null ? firstPriceFromText(firstPrice) : null;
        logger.info(
          {
            tag: "wb-wallet-open-card",
            nmIdRequested: nmId,
            destRequested: requestedDest || null,
            pageUrl: page.url(),
            nmIdInUrl: ctx.nmId,
            destInUrl: ctx.dest,
            priceBlockConfirmed: Boolean(firstPrice),
            firstVisiblePriceText: firstPrice,
          },
          "buyer card opened and price block hydrated",
        );
        if (ctx.nmId != null && ctx.nmId !== nmId) {
          throw new Error(`opened unexpected card nmId=${ctx.nmId}, expected=${nmId}`);
        }
        if (requestedDest.length > 0) {
          let destInBar: string | null = null;
          try {
            destInBar = new URL(page.url()).searchParams.get("dest");
          } catch {
            destInBar = null;
          }
          if (destInBar !== requestedDest) {
            logger.warn(
              {
                tag: "wb-wallet-dest",
                nmId,
                requestedDest,
                destInAddressBar: destInBar,
                pageUrl: page.url(),
              },
              "WB: в адресе вкладки нет нужного dest (часто SPA/профиль); повторный переход на карточку",
            );
            const navRedo = await gotoVerified(page, url, resolved.label, `product-redo-dest-${attempt}`);
            lastDocHttpStatus = navRedo.httpStatus;
            if (navRedo.ok) {
              await waitPriceReady(page);
              const firstPriceRedo = await firstVisiblePriceText(page);
              logger.info(
                {
                  tag: "wb-wallet-open-card",
                  nmIdRequested: nmId,
                  destRequested: requestedDest || null,
                  pageUrl: page.url(),
                  firstVisiblePriceText: firstPriceRedo,
                },
                "buyer card reopened for dest stabilization",
              );
            }
          }
        }
        try {
          await page.evaluate(() => {
            const h = document.body?.scrollHeight ?? 0;
            window.scrollTo(0, Math.min(1400, Math.max(400, h * 0.35)));
          });
        } catch {
          /* ignore */
        }
        await page.waitForTimeout(1100);
        await page.waitForTimeout(2500 + attempt * 1500);
        if (publicRuntime) {
          await page.waitForTimeout(publicExtraWaitMs());
          await page.waitForTimeout(randomPublicJitterWaitMs());
        }
        await Promise.allSettled(cardInflight);
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 2) {
          throw err;
        }
      }
    }
    if (lastErr) {
      /* silence strict narrowing */
    }

    const bodyPreview = await page.innerText("body").catch(() => "");
    const pageTitleEarly = await page.title().catch(() => "");
    const sig = detectPublicParseBlockSignals({
      bodyText: bodyPreview,
      pageUrl: page.url(),
      expectedNmId: nmId,
      mainResponseStatus: lastDocHttpStatus,
    });
    if (sig.reason !== "ok") {
      logger.warn(
        {
          tag: "public_parse_block_detected",
          nmId,
          url: page.url(),
          reason: sig.reason,
          legacyParseStatus: sig.legacyParseStatus,
          httpStatus: lastDocHttpStatus,
          parseStatusProbe: sig.legacyParseStatus ?? "blocked_or_captcha",
        },
        "public parse: страница похожа на блок/капчу/редирект",
      );
      await saveArtifacts(page, nmId, [], "", dedupe([...networkUrls]));
      const snippet = bodyPreview.slice(0, 4096);
      const dbg = (
        await savePublicParseDebugArtifacts({
          page,
          nmId,
          reason: sig.reason,
          pageTitle: pageTitleEarly,
          bodySnippet: snippet,
          attemptIndex: input.attemptIndex,
        })
      ).paths;
      const parseStatusBlocked: WalletParseStatus =
        sig.legacyParseStatus ?? (sig.reason === "auth_required" ? "auth_required" : "blocked_or_captcha");
      return {
        nmId,
        url,
        region: input.region ?? null,
        priceRegular: null,
        discountedPrice: null,
        priceWallet: null,
        walletLabel: null,
        walletDiscountText: null,
        inStock: null,
        parsedAt: new Date().toISOString(),
        source: "dom",
        parseStatus: parseStatusBlocked,
        sourceConfidence: 0,
        parseMethod:
          sig.reason === "captcha"
            ? "page_blocked_captcha"
            : sig.reason === "anti_bot_page"
              ? "page_blocked_antibot"
              : "page_blocked",
        browserUrlAfterParse: page.url(),
        blockReason: sig.reason,
        pageTitle: pageTitleEarly,
        pageTextSnippet: snippet,
        mainResponseHttpStatus: lastDocHttpStatus,
        debugArtifactPaths: dbg.length > 0 ? dbg : undefined,
      };
    }

    const jsonHint = await extractJsonLdPriceHints(page);
    /** DOM до открытия модалки — кандидат витрины + иконка кошелька. */
    let preDom = await extractDomSignals(page);
    if (
      (preDom.showcaseWalletPriceCandidate == null || preDom.showcaseWalletPriceCandidate <= 0) &&
      preDom.walletIconDetected
    ) {
      const ocr = await tryWalletPriceViaScreenshotOcr(page, nmId);
      logger.info(
        {
          tag: "wb-wallet-ocr",
          nmId,
          method: ocr.method,
          walletDetected: ocr.walletDetected,
          extractedText: ocr.extractedText,
          parsedPrice: ocr.parsedPrice,
        },
        "wallet OCR fallback result",
      );
      if (ocr.parsedPrice != null && ocr.parsedPrice > 0) {
        preDom = {
          ...preDom,
          showcaseWalletPriceCandidate: ocr.parsedPrice,
          walletPrice: preDom.walletPrice ?? ocr.parsedPrice,
        };
      }
    }
    logger.info(
      {
        tag: "wb-wallet-forensic",
        nmId,
        phase: "dom_signals_initial",
        walletIconFound: preDom.walletIconDetected,
        visibleShowcaseCandidateRub: preDom.showcaseWalletPriceCandidate,
        domRegularRub: preDom.regularPrice,
        rawPriceBlockText: (preDom as any).priceBlockTexts ?? null,
        priceNodes: (preDom as any).priceNodesDebug ?? [],
      },
      "forensic: initial DOM signals for wallet selector",
    );

    const showcaseRubFromDom = preDom.showcaseWalletPriceCandidate ?? null;
    const walletPriceFromDom =
      preDom.walletIconDetected === true && showcaseRubFromDom != null && showcaseRubFromDom > 0
        ? showcaseRubFromDom
        : null;
    const forensicDecision = {
      nmId,
      rawPriceBlockText: (preDom as any).priceBlockTexts ?? null,
      candidateNumbersInOrder:
        ((preDom as any).priceNodesDebug as { parsedNumber: number | null }[] | undefined)?.map((x) => x.parsedNumber) ??
        null,
      walletIconFound: preDom.walletIconDetected,
      chosenNodeIndex:
        ((preDom as any).priceNodesDebug as { index: number; parsedNumber: number | null }[] | undefined)?.find(
          (x) => x.parsedNumber === showcaseRubFromDom,
        )?.index ?? null,
      chosenNodeText:
        ((preDom as any).priceNodesDebug as { innerText: string; parsedNumber: number | null }[] | undefined)?.find(
          (x) => x.parsedNumber === showcaseRubFromDom,
        )?.innerText ?? null,
      chosenParsedRub: showcaseRubFromDom,
      chosenReason:
        preDom.walletIconDetected && showcaseRubFromDom != null
          ? "showcaseWalletPriceCandidate_with_wallet_icon"
          : showcaseRubFromDom != null
            ? "showcaseWalletPriceCandidate_no_icon"
            : "no_wallet_candidate",
    };
    logger.info(
      {
        tag: "wb-wallet-forensic",
        phase: "dom_candidate_decision",
        ...forensicDecision,
      },
      "forensic: DOM wallet candidate decision",
    );

    logger.info(
      {
        tag: "wb-wallet-verify",
        nmId,
        walletSelectorFound: showcaseRubFromDom != null,
        walletPriceRubAcceptedFromDom: walletPriceFromDom,
        trustedSource:
          preDom.walletIconDetected === true && showcaseRubFromDom != null && showcaseRubFromDom > 0
            ? "product_page_wallet_selector"
            : "none",
        showcaseRubFromDom,
      },
      "buyer flow: DOM wallet parsing active",
    );
    const dom = preDom;
    await saveArtifacts(page, nmId, dom.lines, dom.priceBlockHtml, dedupe([...networkUrls]));

    let result = buildWalletResult({
      nmId,
      url,
      region: input.region ?? null,
      dom,
      jsonHint,
    });
    if (dom.oldPriceRub != null) {
      result = { ...result, oldPriceRub: dom.oldPriceRub };
    }

    let cardRubFromPageNetwork: number | null = null;
    for (const body of capturedCardBodies) {
      const r = parseShowcaseRubFromCardDetailJsonOrNested(body, nmId);
      if (r != null) {
        cardRubFromPageNetwork = r;
        break;
      }
    }
    if (cardRubFromPageNetwork == null) {
      const viaFetch = await fetchShowcaseRubViaPageEvaluate(page, nmId, input.region);
      if (viaFetch != null) {
        cardRubFromPageNetwork = viaFetch;
      }
    }
    if (cardRubFromPageNetwork == null) {
      const viaTop = await tryShowcaseRubViaCardWbTopLevelNavigation(page, nmId, input.region, url);
      if (viaTop != null) {
        cardRubFromPageNetwork = viaTop;
        logger.info({ tag: "wb-wallet", nmId }, "витрина: card.wb.ru через document navigation (обход 403)");
      }
    }
    let cardWalletRub: number | null = null;
    for (const body of capturedCardBodies) {
      const w = parseWalletRubFromCardDetailJsonOrNested(body, nmId);
      if (w != null && w > 0) {
        cardWalletRub = w;
        break;
      }
    }
    const buyerPriceVerification = computeBuyerPriceVerification({
      sellerBasePriceRub: null,
      showcaseWalletPriceCandidate: showcaseRubFromDom,
      walletIconDetected: preDom.walletIconDetected,
      cardApiShowcaseRub: cardRubFromPageNetwork,
      cardApiWalletRub: cardWalletRub,
    });
    result = {
      ...result,
      cardApiShowcaseRub: cardRubFromPageNetwork,
      cardApiWalletRub: cardWalletRub,
      showcaseRubFromCardApi: cardRubFromPageNetwork,
      showcaseRubFromDom,
      showcasePriceRub: showcaseRubFromDom ?? null,
      priceWithSppWithoutWalletRub: null,
      verificationMethod: buyerPriceVerification.verificationMethod,
      verificationStatus: buyerPriceVerification.verificationStatus,
      verificationReason: buyerPriceVerification.verificationReason,
      verificationSource:
        buyerPriceVerification.trustedSource === "product_page_wallet_selector"
          ? "product_page_wallet_selector"
          : "dom_buybox",
      sourcePriority: "dom_wallet_only",
      sourceConflictDetected: false,
      sourceConflictDeltaRub: null,
      conflictAcceptedSource: "none",
      firstVisiblePriceText: firstVisiblePriceTextRaw,
      walletPriceRubAcceptedFromDom: walletPriceFromDom,
      buyerPriceVerification: {
        ...buyerPriceVerification,
        sellerBasePriceRub: null,
      },
    };
    logger.info(
      {
        tag: "wb-wallet-verify",
        nmId,
        verificationStatus: buyerPriceVerification.verificationStatus,
        verificationReason: buyerPriceVerification.verificationReason,
        repricingAllowed: buyerPriceVerification.repricingAllowed,
        repricingAllowedReason:
          buyerPriceVerification.repricingAllowed === true
            ? "dom_wallet_detected"
            : buyerPriceVerification.verificationReason,
        verificationMethod: buyerPriceVerification.verificationMethod,
        trustedSource: buyerPriceVerification.trustedSource,
      },
      "buyer DOM wallet verification summary",
    );

    if (result.parseStatus === "parse_failed") {
      await logBlankPageDiagnostics(page, resolved.label, "parse-failed");
    }

    const snippetFinal = (await page.innerText("body").catch(() => "")).slice(0, 4096);
    const titleFinal = await page.title().catch(() => "");
    let out: WalletParserResult = {
      ...result,
      browserUrlAfterParse: page.url(),
      pageTitle: titleFinal,
      pageTextSnippet: snippetFinal,
      mainResponseHttpStatus: lastDocHttpStatus,
    };
    if (out.parseStatus === "parse_failed" && !out.blockReason) {
      out = { ...out, blockReason: "selector_missing" };
      logger.warn(
        { tag: "public_parse_selector_missing", nmId, parseStatus: out.parseStatus },
        "DOM без уверенной цены после проверки блоков",
      );
    }
    if (
      envPublicParseDebugEnabled() &&
      publicRuntime &&
      out.parseStatus === "parse_failed"
    ) {
      const paths = (
        await savePublicParseDebugArtifacts({
          page,
          nmId,
          reason: out.blockReason ?? "unexpected",
          pageTitle: titleFinal,
          bodySnippet: snippetFinal,
          attemptIndex: input.attemptIndex,
        })
      ).paths;
      out = { ...out, debugArtifactPaths: paths };
    }

    const okDom =
      out.parseStatus === "wallet_found" ||
      out.parseStatus === "only_regular_found" ||
      (out.priceRegular != null && out.priceRegular > 0);
    logger.info(
      {
        tag: okDom ? "public_parse_success" : "public_parse_failed",
        nmId,
        parseStatus: out.parseStatus,
        blockReason: out.blockReason ?? null,
        priceParseSource: out.priceParseSource ?? null,
        confidence: out.sourceConfidence,
      },
      okDom ? "product page scrape success" : "product page scrape finished without usable price",
    );

    return out;
  } finally {
    detachCardSniffer();
  }
}

export type WbBuyerProfileLoginInput = {
  userDataDir: string;
  proxy?: string;
  headless?: boolean;
  browser?: BrowserKind;
  forceUnlockProfile?: boolean;
  /**
   * Без stdin: ждём появления типичных cookie сессии WB (для запуска из веб-сервера).
   */
  waitForSessionAuto?: boolean;
  /** Максимум ожидания входа, мс (по умолчанию 15 мин). */
  maxWaitMs?: number;
};

export type WbBuyerProfileLoginResult = {
  ok: true;
  userDataDir: string;
  savedAt: string;
  mode: "login_only";
};

/**
 * Только сохранение сессии покупателя в persistent profile — nmId / url не нужны.
 * После Enter контекст закрывается; дальше Sync в приложении использует этот профиль.
 */
export async function runWbBuyerProfileLogin(
  input: WbBuyerProfileLoginInput,
): Promise<WbBuyerProfileLoginResult> {
  if (input.headless ?? true) {
    throw new Error(
      "login-only mode requires headless=false (нужно видимое окно браузера для входа в WB)",
    );
  }

  const profileAbs = path.resolve(input.userDataDir);
  const browserKind: BrowserKind =
    input.browser ??
    (env.BROWSER_EXECUTABLE_PATH.trim()
      ? "chrome"
      : process.platform === "darwin"
        ? "chrome"
        : "chromium");
  const resolved = resolveLaunchBrowser(browserKind);

  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    locale: "ru-RU",
    proxy: input.proxy ? { server: input.proxy } : undefined,
    viewport: { width: 1440, height: 1900 },
    ...(resolved.executablePath
      ? { executablePath: resolved.executablePath }
      : {}),
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble",
    ],
  };

  // eslint-disable-next-line no-console
  console.error(`[wb-wallet] login-only; browserExecutable=${resolved.label}; profile=${profileAbs}`);

  const preUnlock =
    input.forceUnlockProfile === true || envTruthy("WB_WALLET_UNLOCK_PROFILE");

  const context = await launchPersistentContextWithSingletonRetry(
    profileAbs,
    launchOpts,
    { preUnlock },
  );

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });

  async function detectBuyerSession(): Promise<boolean> {
    const all = await context.cookies();
    const wb = all.filter(
      (c) =>
        /wildberries|\.wb\.ru|wbcontent/i.test(c.domain) ||
        c.domain === ".wildberries.ru",
    );
    const names = new Set(wb.map((c) => c.name));
    const looksLikeAuth =
      names.has("_wbauid") ||
      names.has("x_wbaas") ||
      names.has("wbx-refresh") ||
      names.has("WBTokenV3") ||
      names.has("wbToken") ||
      names.has("jwt_global") ||
      names.has("__wuid") ||
      names.has("x-supplier-id-external");
    // Эвристика: после входа обычно много cookie на домены WB.
    const heavySession = wb.length >= 14 && names.size >= 6;
    return looksLikeAuth || heavySession;
  }

  try {
    const page = await context.newPage();
    await openLoginFlow(page, resolved.label);
    const auto = input.waitForSessionAuto === true;
    const maxWait = Math.min(
      Math.max(input.maxWaitMs ?? 900_000, 30_000),
      1_800_000,
    );

    if (auto) {
      // stderr only — stdout оставляем чистым под JSON для веб-сервера (Python json.loads).
      // eslint-disable-next-line no-console
      console.error(
        `[wb-wallet] LOGIN: войдите в WB в открытом окне. Ожидание до ${Math.round(maxWait / 60_000)} мин (авто-определение сессии).`,
      );
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        if (await detectBuyerSession()) {
          return {
            ok: true,
            userDataDir: profileAbs,
            savedAt: new Date().toISOString(),
            mode: "login_only",
          };
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(
        "Не удалось определить вход за отведённое время. Повторите попытку.",
      );
    }

    // eslint-disable-next-line no-console
    console.error(
      "LOGIN ONLY: войдите в Wildberries в открывшемся окне, затем нажмите Enter в этом терминале (nmId не нужен).",
    );
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });
    return {
      ok: true,
      userDataDir: profileAbs,
      savedAt: new Date().toISOString(),
      mode: "login_only",
    };
  } finally {
    await context.close();
  }
}

export type WalletBatchStep = {
  nmId: number;
  region?: string | null;
  /** Остаток из кабинета (WB); вместе с DOM определяет OUT_OF_STOCK для витрины. */
  cabinetStock?: number | null;
};

function skipPriceDetailsModal(): boolean {
  const v = env.REPRICER_WALLET_SKIP_PRICE_DETAILS_MODAL.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Эвристика слоя источника цены (не блокирует пайплайн при спорных случаях).
 */
export function inferWalletPriceParseSource(input: {
  plainAfterScrape: WalletParserResult;
  popup: { popupOpened: boolean; walletRub: number | null; withoutWalletRub: number | null };
  final: WalletParserResult;
}): WalletPriceParseSource {
  const p = input.plainAfterScrape;
  const { popupOpened, walletRub: popupWalletRub } = input.popup;
  const f = input.final;

  const domWalletOk =
    p.parseStatus === "wallet_found" ||
    Number(p.walletPriceRubAcceptedFromDom ?? p.showcaseWalletPriceCandidate ?? 0) > 0;

  const domRegularOk =
    p.parseStatus === "only_regular_found" ||
    (p.priceRegular != null && Number.isFinite(p.priceRegular) && p.priceRegular > 0);

  const popupFixedWallet =
    popupOpened &&
    popupWalletRub != null &&
    popupWalletRub > 0 &&
    !domWalletOk &&
    (p.parseStatus === "parse_failed" || p.parseStatus === "only_regular_found");

  if (popupFixedWallet) {
    return "popup_dom";
  }

  const cookiesRecoveredAfterDomFail =
    (f.showcaseResolvedSource === "card_api" || f.verificationSource === "card_api") &&
    p.parseStatus === "parse_failed" &&
    !(popupOpened && popupWalletRub != null && popupWalletRub > 0);

  if (cookiesRecoveredAfterDomFail) {
    return "unknown";
  }

  if (domWalletOk || domRegularOk) {
    return "public_dom";
  }

  if (
    (f.showcaseResolvedSource === "card_api" || f.verificationSource === "card_api") &&
    f.showcaseRubEffective != null &&
    f.showcaseRubEffective > 0
  ) {
    return "unknown";
  }

  return "unknown";
}

export async function getWbWalletPrice(input: WalletParserInput): Promise<WalletParserResult> {
  return runExclusiveBuyerChromeProfile(() => getWbWalletPriceUnlocked(input));
}

async function getWbWalletPriceUnlocked(input: WalletParserInput): Promise<WalletParserResult> {
  const networkUrls = new Set<string>();

  const usePublic = usePublicRuntimeConfig(input);

  const browserKind: BrowserKind = usePublic
    ? env.REPRICER_PUBLIC_BROWSER_CHANNEL === "chrome"
      ? "chrome"
      : "chromium"
    : input.browser ??
      (env.BROWSER_EXECUTABLE_PATH.trim()
        ? "chrome"
        : process.platform === "darwin"
          ? "chrome"
          : "chromium");
  const resolved = resolveLaunchBrowser(browserKind);

  let launchOpts: Parameters<typeof chromium.launchPersistentContext>[1];
  if (usePublic) {
    const hl = resolvePublicBrowserHeadless(input.headless);
    if (hl.headedFallback && hl.note) {
      logger.warn({ tag: "public_browser_launch", note: hl.note }, "public browser headed fallback");
    }
    launchOpts = buildPublicPersistentLaunchOptions({
      resolvedExecutablePath: resolved.executablePath,
      headless: hl.headless,
      proxy: buildPublicProxyFromEnv(),
      inputProxy: input.proxy,
    });
  } else {
    launchOpts = {
      headless: input.headless ?? true,
      locale: "ru-RU",
      proxy: input.proxy ? { server: input.proxy } : undefined,
      viewport: { width: 1440, height: 1900 },
      ...(resolved.executablePath ? { executablePath: resolved.executablePath } : {}),
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-session-crashed-bubble",
      ],
    };
  }

  // eslint-disable-next-line no-console
  console.error(`[wb-wallet] launching persistent context; browserExecutable=${resolved.label}`);

  const preUnlock =
    input.forceUnlockProfile === true || envTruthy("WB_WALLET_UNLOCK_PROFILE");

  const context = await launchPersistentContextWithSingletonRetry(
    input.userDataDir,
    launchOpts,
    { preUnlock },
  );

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });

  if (usePublic) {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(window, "chrome", {
          configurable: true,
          value: { runtime: {} },
        });
      } catch {
        /* ignore */
      }
    });
  }

  try {
    const page = await context.newPage();
    if (input.loginMode) {
      await openLoginFlow(page, resolved.label);
      // eslint-disable-next-line no-console
      console.log(
        "LOGIN MODE: complete manual login in the opened Wildberries tab, then press Enter in this terminal to continue…",
      );
      await new Promise<void>((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", () => resolve());
      });
    }
    attachWalletNetworkCollectors(page, networkUrls);
    const dom = await scrapeWalletPriceOnPage(page, input, resolved, networkUrls);
    if (input.fetchShowcaseWithCookies === true && input.nmId != null && !isPublicOnlyWalletParse()) {
      const stockLevel = resolveStockLevel(null, dom.inStock);
      const orc = await resolveShowcaseForMonitorStep({
        walletDom: dom,
        api: page.request,
        page,
        nmId: input.nmId,
        regionDest: input.region ?? null,
        fallbackDest: env.REPRICER_WALLET_DEST.trim() || null,
        tryCardApi: true,
        maxCardAttempts: env.REPRICER_MONITOR_CARD_API_MAX_ATTEMPTS,
        stockLevel,
      });
      const merged = {
        ...dom,
        showcaseRubEffective: orc.effectiveShowcaseRub,
        showcaseResolvedSource: orc.source,
        showcasePriceRub: orc.showcasePriceRub,
        priceWithSppWithoutWalletRub: orc.priceWithSppWithoutWalletRub,
        verificationSource: orc.verificationSource,
        sourcePriority: orc.sourcePriority,
        sourceConflictDetected: orc.sourceConflictDetected,
        sourceConflictDeltaRub: orc.sourceConflictDeltaRub,
        conflictAcceptedSource: orc.conflictAcceptedSource,
        showcaseApiRub: orc.apiShowcaseRub,
        apiWalletRub: orc.apiWalletRub,
        showcaseResolutionNote: orc.resolutionNote,
        showcaseRubFromCookies: orc.apiShowcaseRub,
        showcaseQueryDest: orc.destEffective,
      };
      const priceParseSource = inferWalletPriceParseSource({
        plainAfterScrape: dom,
        popup: { popupOpened: false, walletRub: null, withoutWalletRub: null },
        final: merged,
      });
      return { ...merged, priceParseSource };
    }
    const priceParseSource = inferWalletPriceParseSource({
      plainAfterScrape: dom,
      popup: { popupOpened: false, walletRub: null, withoutWalletRub: null },
      final: dom,
    });
    return { ...dom, priceParseSource };
  } finally {
    await context.close();
  }
}

/**
 * Один запуск браузера: последовательный обход нескольких карточек (nmId × dest).
 * Сильно быстрее, чем отдельный процесс/контекст на каждый шаг мониторинга.
 */
export async function getWbWalletPriceBatch(
  base: Omit<WalletParserInput, "nmId" | "url" | "region" | "loginMode">,
  steps: WalletBatchStep[],
  opts?: {
    interStepDelayMs?: number;
    /** Пробовать card.wb.ru, если на странице товара не удалось взять обычную цену (fallback). */
    fetchShowcaseWithCookies?: boolean;
    /** Если у шага нет dest — подставить в card API (например из REPRICER_WALLET_DEST) */
    cardDetailFallbackDest?: string | null;
    /** Ретраи card.wb.ru на шаг (по умолчанию 3). */
    maxCardApiAttempts?: number;
  },
): Promise<WalletParserResult[]> {
  if (steps.length === 0) {
    return [];
  }
  return runExclusiveBuyerChromeProfile(() =>
    getWbWalletPriceBatchUnlocked(base, steps, opts),
  );
}

async function getWbWalletPriceBatchUnlocked(
  base: Omit<WalletParserInput, "nmId" | "url" | "region" | "loginMode">,
  steps: WalletBatchStep[],
  opts?: {
    interStepDelayMs?: number;
    fetchShowcaseWithCookies?: boolean;
    cardDetailFallbackDest?: string | null;
    maxCardApiAttempts?: number;
  },
): Promise<WalletParserResult[]> {
  const networkUrls = new Set<string>();
  const usePublic = isPublicOnlyWalletParse() || base.applyPublicBrowserEnv === true;

  const browserKind: BrowserKind = usePublic
    ? env.REPRICER_PUBLIC_BROWSER_CHANNEL === "chrome"
      ? "chrome"
      : "chromium"
    : base.browser ??
      (env.BROWSER_EXECUTABLE_PATH.trim()
        ? "chrome"
        : process.platform === "darwin"
          ? "chrome"
          : "chromium");
  const resolved = resolveLaunchBrowser(browserKind);

  let launchOpts: Parameters<typeof chromium.launchPersistentContext>[1];
  if (usePublic) {
    const hl = resolvePublicBrowserHeadless(base.headless);
    if (hl.headedFallback && hl.note) {
      logger.warn({ tag: "public_browser_launch", note: hl.note }, "batch: public browser headed fallback");
    }
    launchOpts = buildPublicPersistentLaunchOptions({
      resolvedExecutablePath: resolved.executablePath,
      headless: hl.headless,
      proxy: buildPublicProxyFromEnv(),
      inputProxy: base.proxy,
    });
  } else {
    launchOpts = {
      headless: base.headless ?? true,
      locale: "ru-RU",
      proxy: base.proxy ? { server: base.proxy } : undefined,
      viewport: { width: 1440, height: 1900 },
      ...(resolved.executablePath ? { executablePath: resolved.executablePath } : {}),
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-session-crashed-bubble",
      ],
    };
  }

  // eslint-disable-next-line no-console
  console.error(
    `[wb-wallet] batch: launching persistent context once; steps=${steps.length}; browserExecutable=${resolved.label}`,
  );

  const preUnlock =
    base.forceUnlockProfile === true || envTruthy("WB_WALLET_UNLOCK_PROFILE");

  const context = await launchPersistentContextWithSingletonRetry(
    base.userDataDir,
    launchOpts,
    { preUnlock },
  );

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });

  if (usePublic) {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(window, "chrome", {
          configurable: true,
          value: { runtime: {} },
        });
      } catch {
        /* ignore */
      }
    });
  }

  const inter = Math.max(0, Math.min(30_000, opts?.interStepDelayMs ?? 0));
  const useShowcaseCookies = opts?.fetchShowcaseWithCookies === true;
  const cardFallback = opts?.cardDetailFallbackDest?.trim() || undefined;

  try {
    const page = await context.newPage();
    attachWalletNetworkCollectors(page, networkUrls);
    const out: WalletParserResult[] = [];
    let prevNmId: number | null = null;
    let prevDestKey = "";
    let prevLocationMarkerForNm: string | null = null;
    let prevPriceSigForNm: string | null = null;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      const regionRaw = step.region?.trim() ?? "";
      const destKey = regionRaw;
      /** Без card.wb.ru по dest витрина в DOM часто одна на все склады — в PUBLIC ONLY card отключён. */
      const runShowcaseOrchestrator =
        !isPublicOnlyWalletParse() && (useShowcaseCookies || regionRaw.length > 0);
      const needsHardNavigationReset =
        i > 0 && (step.nmId !== prevNmId || destKey !== prevDestKey);
      if (needsHardNavigationReset) {
        logger.debug(
          {
            tag: "wb-wallet-batch",
            stepIndex: i,
            prevNmId,
            nmId: step.nmId,
            prevDestKey: prevDestKey || null,
            destKey: destKey || null,
          },
          "batch: сброс вкладки (смена nmId/dest), иначе SPA может оставить цены прошлого региона",
        );
        try {
          await page.goto("about:blank", { waitUntil: "commit", timeout: 15_000 });
        } catch {
          /* ignore */
        }
        await page.waitForTimeout(280);
      }
      if (prevNmId !== step.nmId) {
        prevLocationMarkerForNm = null;
        prevPriceSigForNm = null;
      }
      prevNmId = step.nmId;
      prevDestKey = destKey;

      const merged: WalletParserInput = {
        ...base,
        nmId: step.nmId,
        ...(regionRaw.length > 0 ? { region: regionRaw } : {}),
      };
      try {
        const dom = await scrapeWalletPriceOnPage(page, merged, resolved, networkUrls);
        const strongWalletSignal =
          dom.verificationStatus === "VERIFIED" &&
          dom.verificationMethod === "dom_wallet" &&
          dom.buyerPriceVerification?.trustedSource === "product_page_wallet_selector" &&
          dom.parseStatus === "wallet_found" &&
          (dom.walletPriceRubAcceptedFromDom ?? dom.showcaseWalletPriceCandidate ?? null) != null;
        const firstWalletRead =
          dom.popupWalletRub ??
          dom.walletPriceRubAcceptedFromDom ??
          dom.showcaseWalletPriceCandidate ??
          dom.showcaseRubFromDom ??
          null;
        let secondWalletRead: number | null = null;
        let regionConfirmedByStableReload = false;
        if (runShowcaseOrchestrator && regionRaw.length > 0 && strongWalletSignal) {
          const secondRead = await readWalletAfterHardReload({
            page,
            parserInput: merged,
            resolved,
          }).catch(() => ({ walletRub: null, firstVisibleText: null }));
          secondWalletRead = secondRead.walletRub;
          regionConfirmedByStableReload =
            firstWalletRead != null &&
            secondWalletRead != null &&
            firstWalletRead > 0 &&
            secondWalletRead > 0 &&
            firstWalletRead === secondWalletRead;
        }
        const popup = skipPriceDetailsModal()
          ? { popupOpened: false, walletRub: null, withoutWalletRub: null }
          : await tryOpenPriceDetailsPopup(page).catch(() => ({
              popupOpened: false,
              walletRub: null,
              withoutWalletRub: null,
            }));
        const locationMarker = await extractLocationMarker(page);
        const priceBlockSignature = stableSignature({
          text: Array.isArray(dom.lines) ? dom.lines.join("\n") : "",
          html: dom.priceBlockHtml ?? "",
          marker: locationMarker,
        });
        const confirmed = await confirmDestApplied({
          page,
          expectedNmId: step.nmId,
          expectedDest: regionRaw.length > 0 ? regionRaw : null,
          prevLocationMarker: prevLocationMarkerForNm,
          prevPriceBlockSignature: prevPriceSigForNm,
          currentLocationMarker: locationMarker,
          currentPriceBlockSignature: priceBlockSignature,
          popupOpened: popup.popupOpened,
          popupWalletRub: popup.walletRub,
          popupWithoutWalletRub: popup.withoutWalletRub,
          stableReloadConfirmed: regionConfirmedByStableReload,
        });
        prevLocationMarkerForNm = locationMarker;
        prevPriceSigForNm = priceBlockSignature;
        const domWithRegionSignals: WalletParserResult = {
          ...dom,
          destApplied: confirmed.destApplied,
          regionConfirmed: confirmed.regionConfirmed,
          destAppliedButNotConfirmed: confirmed.destAppliedButNotConfirmed,
          locationMarker,
          priceBlockSignature,
          popupOpened: popup.popupOpened,
          popupWalletRub: popup.walletRub,
          popupWithoutWalletRub: popup.withoutWalletRub,
          regionDomConfirmed: confirmed.regionDomConfirmed,
          regionConfirmedByRequest: confirmed.regionConfirmedByRequest,
          regionConfirmedByStableReload: confirmed.regionConfirmedByStableReload,
          walletPriceFirstRead: firstWalletRead,
          walletPriceSecondRead: secondWalletRead,
          finalRegionConfidence:
            confirmed.regionConfirmedByStableReload || confirmed.regionDomConfirmed
              ? "HIGH"
              : confirmed.regionConfirmedByRequest
                ? "MEDIUM"
                : "LOW",
          finalWalletConfidence:
            strongWalletSignal && regionConfirmedByStableReload
              ? "HIGH"
              : strongWalletSignal
                ? "MEDIUM"
                : "LOW",
          repricingDecisionSource:
            strongWalletSignal && (confirmed.regionConfirmedByRequest || confirmed.regionConfirmedByStableReload)
              ? "strong_wallet_plus_region_request_or_stable_reload"
              : strongWalletSignal && confirmed.regionDomConfirmed
                ? "strong_wallet_plus_dom_region_marker"
                : "wallet_or_region_not_strong_enough",
        };

        let mergedResult: WalletParserResult;
        if (runShowcaseOrchestrator) {
          const stockLevel = resolveStockLevel(step.cabinetStock, dom.inStock);
          const orc = await resolveRegionalShowcasePrice({
            walletDom: domWithRegionSignals,
            page,
            nmId: step.nmId,
            regionDest: regionRaw.length > 0 ? regionRaw : null,
            fallbackDest: cardFallback ?? null,
            maxCardAttempts: opts?.maxCardApiAttempts,
            stockLevel,
          });
          mergedResult = {
            ...domWithRegionSignals,
            showcaseRubEffective: orc.effectiveShowcaseRub,
            showcaseResolvedSource: orc.source,
            showcasePriceRub: orc.showcasePriceRub,
            priceWithSppWithoutWalletRub: orc.priceWithSppWithoutWalletRub,
            verificationSource: orc.verificationSource,
            sourcePriority: orc.sourcePriority,
            sourceConflictDetected: orc.sourceConflictDetected,
            sourceConflictDeltaRub: orc.sourceConflictDeltaRub,
            conflictAcceptedSource: orc.conflictAcceptedSource,
            showcaseApiRub: orc.apiShowcaseRub,
            apiWalletRub: orc.apiWalletRub,
            showcaseResolutionNote: orc.resolutionNote,
            showcaseRubFromCookies: orc.apiShowcaseRub,
            showcaseQueryDest: orc.destEffective,
          };
        } else {
          mergedResult = domWithRegionSignals;
        }
        const priceParseSource = inferWalletPriceParseSource({
          plainAfterScrape: dom,
          popup,
          final: mergedResult,
        });
        out.push({ ...mergedResult, priceParseSource });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const { url, nmId } = ensureUrl(merged);
        out.push({
          nmId,
          url,
          region: merged.region ?? null,
          priceRegular: null,
          discountedPrice: null,
          priceWallet: null,
          walletLabel: null,
          walletDiscountText: null,
          inStock: null,
          parsedAt: new Date().toISOString(),
          source: "dom",
          parseStatus: "parse_failed",
          sourceConfidence: 0,
          parseMethod: "batch_step_exception",
          showcaseRubEffective: null,
          showcaseResolvedSource: "none",
          showcaseApiRub: null,
          showcaseResolutionNote: "batch_step_exception",
          showcaseRubFromCookies: null,
          browserUrlAfterParse: null,
          showcaseQueryDest: null,
          destApplied: false,
          regionConfirmed: false,
          destAppliedButNotConfirmed: false,
          locationMarker: null,
          priceBlockSignature: null,
          popupOpened: false,
          popupWalletRub: null,
          popupWithoutWalletRub: null,
          regionPriceAmbiguous: false,
          regionDomConfirmed: false,
          regionConfirmedByRequest: false,
          regionConfirmedByStableReload: false,
          walletPriceFirstRead: null,
          walletPriceSecondRead: null,
          finalRegionConfidence: "LOW",
          finalWalletConfidence: "LOW",
          repricingDecisionSource: "batch_step_exception",
          priceParseSource: "unknown",
        });
        // eslint-disable-next-line no-console
        console.error(`[wb-wallet] batch step failed nmId=${step.nmId}:`, msg);
      }
      if (inter > 0 && i < steps.length - 1) {
        await page.waitForTimeout(inter);
      }
    }
    // batch-level ambiguity:
    // если один и тот же firstVisiblePriceText и один и тот же wallet DOM по всем dest,
    // но card API меняется, то local DOM не подтверждает региональность.
    const byNm = new Map<number, WalletParserResult[]>();
    for (const r of out) {
      if (typeof r.nmId === "number" && Number.isFinite(r.nmId)) {
        const arr = byNm.get(r.nmId) ?? [];
        arr.push(r);
        byNm.set(r.nmId, arr);
      }
    }
    for (const [, rows] of byNm) {
      if (rows.length < 2) continue;
      const firstVisibleTexts = rows
        .map((r) => (typeof r.firstVisiblePriceText === "string" ? r.firstVisiblePriceText.trim() : ""))
        .filter((s) => s.length > 0);
      const allSameFirstVisible =
        firstVisibleTexts.length >= 2 && firstVisibleTexts.every((t) => t === firstVisibleTexts[0]);
      const walletVals = rows
        .map((r) => r.walletPriceRubAcceptedFromDom ?? r.showcaseWalletPriceCandidate ?? r.showcaseRubFromDom ?? null)
        .filter((x): x is number => x != null && Number.isFinite(x) && x > 0);
      if (walletVals.length < 2) continue;
      const allSameWallet = walletVals.every((x) => x === walletVals[0]);
      if (!allSameWallet) continue;
      const popupWalletVals = rows
        .map((r) => r.popupWalletRub ?? null)
        .filter((x): x is number => x != null && Number.isFinite(x) && x > 0);
      const popupWalletDiffers =
        popupWalletVals.length >= 2 && !popupWalletVals.every((x) => x === popupWalletVals[0]);
      const cardVals = rows
        .map((r) => r.showcaseApiRub ?? r.cardApiShowcaseRub ?? null)
        .filter((x): x is number => x != null && Number.isFinite(x) && x > 0);
      const cardDiffers = cardVals.length >= 2 && !cardVals.every((x) => x === cardVals[0]);
      const ambiguous =
        allSameFirstVisible &&
        allSameWallet &&
        cardDiffers &&
        !popupWalletDiffers;
      if (!ambiguous) continue;
      const hasStableRows = rows.some((r) => r.regionConfirmedByStableReload === true);
      if (hasStableRows) {
        logger.info(
          {
            tag: "wb-wallet-region",
            nmId: rows[0]?.nmId ?? null,
            note: "ambiguous candidate resolved by stable reload confirmation",
            stableRows: rows.filter((r) => r.regionConfirmedByStableReload === true).length,
            totalRows: rows.length,
          },
          "region ambiguity retry passed for at least one stable row",
        );
      }
      for (const r of rows) {
        if (r.regionConfirmedByStableReload === true) {
          r.regionPriceAmbiguous = false;
          r.regionConfirmed = true;
          r.destAppliedButNotConfirmed = false;
          r.repricingDecisionSource = "stable_reload_confirmed";
          continue;
        }
        r.regionPriceAmbiguous = true;
        r.regionConfirmed = false;
        r.destAppliedButNotConfirmed = true;
        r.verificationStatus = "UNVERIFIED";
        r.verificationReason = "region_dom_not_confirmed_same_first_visible_and_wallet_cardapi_diff";
        if (r.buyerPriceVerification) {
          r.buyerPriceVerification = {
            ...r.buyerPriceVerification,
            verificationStatus: "UNVERIFIED",
            verificationReason: "region_dom_not_confirmed_same_first_visible_and_wallet_cardapi_diff",
            verificationMethod: "unverified",
            repricingAllowed: false,
            trustedSource: "none",
          };
        }
      }
      logger.warn(
        {
          tag: "wb-wallet-region",
          nmId: rows[0]?.nmId ?? null,
          firstVisiblePriceText: firstVisibleTexts[0] ?? null,
          walletPriceRubAcceptedFromDom: walletVals[0] ?? null,
          cardApiShowcaseByDest: rows.map((r) => ({
            dest: r.region ?? null,
            cardApiShowcaseRub: r.showcaseApiRub ?? r.cardApiShowcaseRub ?? null,
          })),
        },
        "region ambiguity: same local DOM price across dest while card API differs",
      );
    }

    return out;
  } finally {
    await context.close();
  }
}
