import path from "node:path";
import { chromium } from "playwright";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/** Реалистичный UA по умолчанию (не Playwright/Chromium headless fingerprint в UA). */
export const REPRICER_DEFAULT_PUBLIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function envTruthy(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

export function envPublicParseDebugEnabled(): boolean {
  return envTruthy(env.REPRICER_PUBLIC_PARSE_DEBUG);
}

export function resolvePublicParseDebugDir(): string {
  const raw = env.REPRICER_PUBLIC_PARSE_DEBUG_DIR.trim();
  if (raw) {
    return path.resolve(raw);
  }
  return path.resolve(process.cwd(), env.TMP_DIR, "public-parse-debug");
}

/**
 * Headless из REPRICER_PUBLIC_BROWSER_HEADLESS.
 * Если запрошен headed на Linux без DISPLAY — fallback на headless с логом (сервис не падает).
 */
export function resolvePublicBrowserHeadless(inputExplicit?: boolean): {
  headless: boolean;
  headedFallback: boolean;
  note?: string;
} {
  if (inputExplicit === true || inputExplicit === false) {
    if (inputExplicit === false) {
      const fb = shouldFallbackHeadedToHeadless();
      if (fb.noDisplay) {
        logger.warn(
          { tag: "public_browser_headed", reason: "no_display" },
          "REPRICER_PUBLIC_BROWSER_HEADLESS=false но нет DISPLAY — запускаем headless",
        );
        return { headless: true, headedFallback: true, note: "headed requested but no DISPLAY" };
      }
    }
    return { headless: inputExplicit, headedFallback: false };
  }

  const wantHeadless = envTruthy(env.REPRICER_PUBLIC_BROWSER_HEADLESS);
  if (!wantHeadless) {
    const fb = shouldFallbackHeadedToHeadless();
    if (fb.noDisplay) {
      logger.warn(
        { tag: "public_browser_headed", reason: "no_display" },
        "headed режим недоступен (нет графической среды) — fallback headless",
      );
      return { headless: true, headedFallback: true, note: fb.note };
    }
    return { headless: false, headedFallback: false };
  }
  return { headless: true, headedFallback: false };
}

function shouldFallbackHeadedToHeadless(): { noDisplay: boolean; note?: string } {
  if (process.platform === "darwin") {
    return { noDisplay: false };
  }
  const d = process.env.DISPLAY?.trim();
  if (!d) {
    return { noDisplay: true, note: "DISPLAY unset" };
  }
  return { noDisplay: false };
}

export type PublicProxyConfig =
  | { server: string; username?: string; password?: string }
  | undefined;

export function buildPublicProxyFromEnv(): PublicProxyConfig {
  const server = env.REPRICER_PUBLIC_PROXY_SERVER.trim();
  if (!server) {
    return undefined;
  }
  const username = env.REPRICER_PUBLIC_PROXY_USERNAME.trim();
  const password = env.REPRICER_PUBLIC_PROXY_PASSWORD.trim();
  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

export type PublicPersistentLaunchExtras = Parameters<typeof chromium.launchPersistentContext>[1];

/**
 * Дополнительные опции Playwright для публичного парсинга (viewport, locale, stealth args).
 */
export function buildPublicPersistentLaunchOptions(params: {
  resolvedExecutablePath?: string;
  headless: boolean;
  proxy?: PublicProxyConfig;
  /** Явный proxy из WalletParserInput перекрывает env */
  inputProxy?: string;
}): PublicPersistentLaunchExtras {
  const uaRaw = env.REPRICER_PUBLIC_BROWSER_USER_AGENT.trim();
  const userAgent = uaRaw.length > 0 ? uaRaw : REPRICER_DEFAULT_PUBLIC_USER_AGENT;

  let proxy: { server: string; username?: string; password?: string } | undefined;
  if (params.inputProxy?.trim()) {
    proxy = { server: params.inputProxy.trim() };
  } else if (params.proxy?.server) {
    proxy = params.proxy;
  }

  const slowMo = Math.max(0, Math.min(10_000, env.REPRICER_PUBLIC_BROWSER_SLOWMO_MS));

  const opts: PublicPersistentLaunchExtras = {
    headless: params.headless,
    locale: env.REPRICER_PUBLIC_BROWSER_LOCALE.trim() || "ru-RU",
    timezoneId: env.REPRICER_PUBLIC_BROWSER_TIMEZONE.trim() || "Europe/Moscow",
    viewport: {
      width: env.REPRICER_PUBLIC_BROWSER_VIEWPORT_WIDTH,
      height: env.REPRICER_PUBLIC_BROWSER_VIEWPORT_HEIGHT,
    },
    userAgent,
    ...(proxy ? { proxy } : {}),
    ...(slowMo > 0 ? { slowMo } : {}),
    ...(params.resolvedExecutablePath ? { executablePath: params.resolvedExecutablePath } : {}),
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
    extraHTTPHeaders: {
      "Accept-Language": "ru-RU,ru;q=0.9",
    },
  };

  return opts;
}

export function publicExtraWaitMs(): number {
  return Math.max(0, Math.min(120_000, env.REPRICER_PUBLIC_BROWSER_EXTRA_WAIT_MS));
}

export function publicJitterMs(): number {
  return Math.max(0, Math.min(30_000, env.REPRICER_PUBLIC_BROWSER_JITTER_MS));
}

/** Случайная пауза 0..jitter для анти-паттерна. */
export function randomPublicJitterWaitMs(): number {
  const j = publicJitterMs();
  if (j <= 0) return 0;
  return Math.floor(Math.random() * (j + 1));
}
