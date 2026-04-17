import type { APIRequestContext, Page } from "playwright";
import { logger } from "../lib/logger.js";
import type { StockLevel } from "../lib/stockLevel.js";
import { tryShowcaseRubViaCardWbTopLevelNavigation } from "./cardWbTopNavigation.js";
import {
  parseShowcaseRubFromCardDetailJsonOrNested,
  parseWalletRubFromCardDetailJsonOrNested,
} from "./buyerShowcaseCardRequest.js";

/** Минимум полей из результата парсера страницы (без циклического импорта wbWalletPriceParser). */
export type WalletDomParseLike = {
  priceRegular: number | null;
  priceWallet: number | null;
  showcasePriceRub?: number | null;
  showcaseRubFromDom?: number | null;
  walletIconDetected?: boolean | null;
  /** Подтверждение применения региона (не только URL). */
  regionConfirmed?: boolean | null;
  /** Цена со скидкой продавца на витрине (debug only; не источник кошелька). */
  discountedPrice?: number | null;
  parseStatus: string;
  buyerPriceVerification?: {
    verificationStatus?: "VERIFIED" | "UNVERIFIED";
    walletPriceVerified?: number | null;
    priceWithoutWallet?: number | null;
    verificationMethod?: "dom_wallet" | "unverified";
  } | null;
};

const TAG = "price-source";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterMs(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Заголовки, близкие к обычному запросу из вкладки wildberries.ru (context.request подставит cookies). */
const CARD_WB_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.wildberries.ru/",
  Origin: "https://www.wildberries.ru",
  "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
};

export type ShowcaseResolvedSource = "product_page_dom" | "card_api" | "none";

export type CardApiAttemptMeta = {
  rub: number | null;
  walletRub: number | null;
  attemptsUsed: number;
  lastHttpStatus: number;
  lastPath: string | null;
  lastError: string | null;
};

/**
 * Один GET к card.wb.ru из Playwright APIRequestContext (куки профиля).
 */
type CardDetailPath = "/cards/v4/detail" | "/cards/v2/detail" | "/cards/v1/detail";

/**
 * fetch из JS страницы (credentials + Referer текущей карточки) — иногда 200, когда Playwright APIRequestContext → 403.
 */
export async function fetchShowcaseRubViaPageEvaluate(
  page: Page,
  nmId: number,
  regionDest: string | null | undefined,
): Promise<number | null> {
  const dest = regionDest?.trim() || "-1257786";
  const paths = ["/cards/v4/detail", "/cards/v2/detail", "/cards/v1/detail"] as const;
  const raw = await page
    .evaluate(
      async (args: { nmId: number; dest: string; paths: readonly string[] }) => {
        const { nmId: nm, dest: d, paths: ps } = args;
        const ref =
          typeof location !== "undefined" && location.href?.startsWith("http")
            ? location.href
            : "https://www.wildberries.ru/";
        for (const path of ps) {
          const url = `https://card.wb.ru${path}?appType=1&curr=rub&dest=${encodeURIComponent(d)}&nm=${nm}`;
          try {
            const r = await fetch(url, {
              credentials: "include",
              mode: "cors",
              headers: {
                Accept: "application/json, text/plain, */*",
                "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
                Referer: ref,
                Origin: "https://www.wildberries.ru",
              },
            });
            if (!r.ok) {
              continue;
            }
            return await r.json();
          } catch {
            continue;
          }
        }
        return null;
      },
      { nmId, dest, paths },
    )
    .catch(() => null);
  if (raw == null) {
    return null;
  }
  return parseShowcaseRubFromCardDetailJsonOrNested(raw, nmId);
}

export async function fetchCardPricePairViaPageEvaluate(
  page: Page,
  nmId: number,
  regionDest: string | null | undefined,
): Promise<{ showcaseRub: number | null; walletRub: number | null }> {
  const dest = regionDest?.trim() || "-1257786";
  const paths = ["/cards/v4/detail", "/cards/v2/detail", "/cards/v1/detail"] as const;
  const raw = await page
    .evaluate(
      async (args: { nmId: number; dest: string; paths: readonly string[] }) => {
        const { nmId: nm, dest: d, paths: ps } = args;
        const ref =
          typeof location !== "undefined" && location.href?.startsWith("http")
            ? location.href
            : "https://www.wildberries.ru/";
        for (const path of ps) {
          const url = `https://card.wb.ru${path}?appType=1&curr=rub&dest=${encodeURIComponent(d)}&nm=${nm}`;
          try {
            const r = await fetch(url, {
              credentials: "include",
              mode: "cors",
              headers: {
                Accept: "application/json, text/plain, */*",
                "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
                Referer: ref,
                Origin: "https://www.wildberries.ru",
              },
            });
            if (!r.ok) continue;
            return await r.json();
          } catch {
            continue;
          }
        }
        return null;
      },
      { nmId, dest, paths },
    )
    .catch(() => null);
  if (raw == null) {
    return { showcaseRub: null, walletRub: null };
  }
  return {
    showcaseRub: parseShowcaseRubFromCardDetailJsonOrNested(raw, nmId),
    walletRub: parseWalletRubFromCardDetailJsonOrNested(raw, nmId),
  };
}

async function fetchOneCardPath(
  api: APIRequestContext,
  path: CardDetailPath,
  nmId: number,
  dest: string,
): Promise<{ rub: number | null; walletRub: number | null; status: number }> {
  const url = `https://card.wb.ru${path}?appType=1&curr=rub&dest=${encodeURIComponent(dest)}&nm=${nmId}`;
  const res = await api.get(url, {
    timeout: 28_000,
    headers: CARD_WB_HEADERS,
  });
  const status = res.status();
  if (status !== 200) {
    return { rub: null, walletRub: null, status };
  }
  const data: unknown = await res.json().catch(() => null);
  const rub = data != null ? parseShowcaseRubFromCardDetailJsonOrNested(data, nmId) : null;
  const walletRub = data != null ? parseWalletRubFromCardDetailJsonOrNested(data, nmId) : null;
  return { rub, walletRub, status };
}

/**
 * card.wb.ru с ретраями; 403/429/5xx/таймаут не роняют мониторинг — возвращаем null.
 */
export async function resolveFromCardApi(
  api: APIRequestContext,
  nmId: number,
  destEffective: string,
  opts?: { maxAttempts?: number },
): Promise<CardApiAttemptMeta> {
  const maxAttempts = Math.min(6, Math.max(1, opts?.maxAttempts ?? 3));
  let lastHttpStatus = 0;
  let lastPath: string | null = null;
  let lastError: string | null = null;
  let seenWalletRub: number | null = null;
  const paths = ["/cards/v4/detail", "/cards/v2/detail", "/cards/v1/detail"] as const;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    if (attempt > 1) {
      await sleep(jitterMs(220, 920));
    }
    const statusesThisRound: number[] = [];
    for (const path of paths) {
      lastPath = path;
      try {
        const { rub, walletRub, status } = await fetchOneCardPath(api, path, nmId, destEffective);
        lastHttpStatus = status;
        statusesThisRound.push(status);
        if (walletRub != null && walletRub > 0) {
          seenWalletRub = walletRub;
        }
        if (rub != null) {
          logger.info(
            {
              tag: TAG,
              source: "card_api",
              nmId,
              showcaseRub: rub,
              walletRub,
              path,
              attempt,
              dest: destEffective,
            },
            "витрина: card.wb.ru успех",
          );
          return {
            rub,
            walletRub: seenWalletRub,
            attemptsUsed: attempt,
            lastHttpStatus: status,
            lastPath: path,
            lastError: null,
          };
        }

        if (status === 403) {
          continue;
        }
        if (status === 429) {
          logger.warn({ tag: TAG, nmId, path, status, attempt }, "card.wb.ru 429 — пауза перед повтором");
          await sleep(jitterMs(900, 2800));
          continue;
        }
        if (status >= 500) {
          logger.warn({ tag: TAG, nmId, path, status, attempt }, "card.wb.ru 5xx — повтор позже");
          await sleep(jitterMs(400, 1400));
          continue;
        }
        if (status === 401) {
          logger.warn({ tag: TAG, nmId, path, status, attempt }, "card.wb.ru 401 — неавторизован для API");
          continue;
        }
        if (status === 200) {
          logger.warn({ tag: TAG, nmId, path, attempt }, "card.wb.ru 200, JSON без цены");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = msg;
        lastHttpStatus = 0;
        statusesThisRound.push(-1);
        logger.warn(
          { tag: TAG, nmId, path, attempt, err: msg },
          "card.wb.ru: таймаут/сеть — повтор при наличии попыток",
        );
        await sleep(jitterMs(300, 1100));
      }
    }

    /** Все пути — 403: на одном раунде WB часто «режет» контекст; следующие раунды с паузой иногда проходят. */
    const all403 =
      statusesThisRound.length >= paths.length &&
      statusesThisRound.slice(0, paths.length).every((s) => s === 403);
    if (all403) {
      if (attempt < maxAttempts) {
        logger.warn(
          {
            tag: TAG,
            nmId,
            dest: destEffective,
            attempt,
            maxAttempts,
            pathsTried: paths,
          },
          "card.wb.ru: все пути 403 — пауза и следующий раунд",
        );
        await sleep(jitterMs(1800, 5500));
        continue;
      }
      logger.warn(
        {
          tag: TAG,
          nmId,
          dest: destEffective,
          attempt,
          pathsTried: paths,
        },
        "card.wb.ru: v4/v2/v1 → 403 после всех раундов — остаётся DOM / fetch со страницы / top nav",
      );
      lastHttpStatus = 403;
      return {
        rub: null,
        walletRub: seenWalletRub,
        attemptsUsed: attempt,
        lastHttpStatus: 403,
        lastPath: "/cards/v1/detail",
        lastError: null,
      };
    }
  }

  logger.warn(
    {
      tag: TAG,
      nmId,
      attemptsUsed,
      lastHttpStatus,
      lastPath,
      lastError,
      dest: destEffective,
    },
    "card.wb.ru: витрина не получена после ретраев (используем только DOM при наличии)",
  );
  return { rub: null, walletRub: seenWalletRub, attemptsUsed, lastHttpStatus, lastPath, lastError };
}

function resolveVerifiedLocalPair(walletDom: WalletDomParseLike): {
  showcaseRub: number | null;
  withoutWalletRub: number | null;
  verificationSource: "dom_buybox" | "none";
} {
  if (walletDom.regionConfirmed !== undefined && walletDom.regionConfirmed !== true) {
    return { showcaseRub: null, withoutWalletRub: null, verificationSource: "none" };
  }
  const v = walletDom.buyerPriceVerification;
  if (!v || v.verificationStatus !== "VERIFIED") {
    return { showcaseRub: null, withoutWalletRub: null, verificationSource: "none" };
  }
  const showcaseRub =
    typeof v.walletPriceVerified === "number" && Number.isFinite(v.walletPriceVerified) && v.walletPriceVerified > 0
      ? Math.round(v.walletPriceVerified)
      : null;
  const withoutWalletRub =
    typeof v.priceWithoutWallet === "number" && Number.isFinite(v.priceWithoutWallet) && v.priceWithoutWallet > 0
      ? Math.round(v.priceWithoutWallet)
      : null;
  return {
    showcaseRub,
    withoutWalletRub,
    verificationSource: v.verificationMethod === "dom_wallet" ? "dom_buybox" : "none",
  };
}

/** Витринная цена = с WB кошельком. Никогда не брать сюда without-wallet. */
export function resolveFromProductPageDom(walletDom: WalletDomParseLike): number | null {
  const verified = resolveVerifiedLocalPair(walletDom).showcaseRub;
  if (verified != null) {
    return verified;
  }
  const walletSelectorRub =
    walletDom.walletIconDetected === true &&
    walletDom.showcasePriceRub != null &&
    Number.isFinite(walletDom.showcasePriceRub) &&
    walletDom.showcasePriceRub > 0
      ? Math.round(walletDom.showcasePriceRub)
      : walletDom.walletIconDetected === true &&
          walletDom.showcaseRubFromDom != null &&
          Number.isFinite(walletDom.showcaseRubFromDom) &&
          walletDom.showcaseRubFromDom > 0
        ? Math.round(walletDom.showcaseRubFromDom)
        : null;
  if (walletSelectorRub != null) {
    return walletSelectorRub;
  }
  const wallet = walletDom.priceWallet;
  if (wallet != null && Number.isFinite(wallet) && wallet > 0) {
    return Math.round(wallet);
  }
  return null;
}

/** Цена WB Кошелька только из DOM-парсера кошелька. */
export function resolveFromWalletDom(walletDom: WalletDomParseLike): number | null {
  const walletSelectorRub =
    walletDom.walletIconDetected === true &&
    walletDom.showcasePriceRub != null &&
    Number.isFinite(walletDom.showcasePriceRub) &&
    walletDom.showcasePriceRub > 0
      ? Math.round(walletDom.showcasePriceRub)
      : walletDom.walletIconDetected === true &&
          walletDom.showcaseRubFromDom != null &&
          Number.isFinite(walletDom.showcaseRubFromDom) &&
          walletDom.showcaseRubFromDom > 0
        ? Math.round(walletDom.showcaseRubFromDom)
        : null;
  if (walletSelectorRub != null) {
    return walletSelectorRub;
  }
  const w = walletDom.priceWallet;
  if (w != null && Number.isFinite(w) && w > 0) {
    return Math.round(w);
  }
  return null;
}

export type ShowcaseOrchestratorResult = {
  effectiveShowcaseRub: number | null;
  showcasePriceRub: number | null;
  priceWithSppWithoutWalletRub: number | null;
  source: ShowcaseResolvedSource;
  verificationSource: "dom_buybox" | "card_api" | "none";
  sourcePriority: string;
  sourceConflictDetected: boolean;
  sourceConflictDeltaRub: number | null;
  conflictAcceptedSource: "local_verified" | "card_api" | "none";
  verifiedLocalShowcaseRub: number | null;
  verifiedLocalWithoutWalletRub: number | null;
  /** Значение с card.wb.ru, если API вызывался и вернул число (даже если не выбрано как итог). */
  apiShowcaseRub: number | null;
  /** Цена WB Кошелька из card.wb.ru (если WB отдаёт отдельное поле). */
  apiWalletRub: number | null;
  resolutionNote: string;
  walletRub: number | null;
  cardMeta: CardApiAttemptMeta | null;
  /** Параметр dest в запросах card.wb.ru (склад WB), не адрес доставки в шапке профиля. */
  destEffective: string;
};

/**
 * Итоговая витринная цена для СПП: сначала страница товара (Playwright), при отсутствии — card.wb.ru с куками и ретраями.
 * Кошелёк не трогаем — только логируем рядом.
 */
export async function resolveShowcaseForMonitorStep(input: {
  walletDom: WalletDomParseLike;
  api: APIRequestContext;
  /** Та же вкладка, что открывала карточку — для page.request и повторного fetch из страницы (обход 403 у context.request). */
  page?: Page | null;
  nmId: number;
  regionDest: string | null;
  fallbackDest?: string | null;
  tryCardApi: boolean;
  maxCardAttempts?: number;
  /** Для логов; остаток не блокирует card/cookies (витрина нужна и при OOS для СПП и сравнения с минимумом). */
  stockLevel?: StockLevel;
}): Promise<ShowcaseOrchestratorResult> {
  const {
    walletDom,
    api,
    page,
    nmId,
    regionDest,
    fallbackDest,
    tryCardApi,
    maxCardAttempts,
    stockLevel: stockLevelRaw,
  } = input;
  const stockLevel: StockLevel = stockLevelRaw ?? "UNKNOWN_STOCK";
  const walletRub = resolveFromWalletDom(walletDom);
  const domRub = resolveFromProductPageDom(walletDom);
  const localVerified = resolveVerifiedLocalPair(walletDom);
  /** WB: цена по складу/региону задаётся `dest`; DOM/meta на SPA часто совпадают между регионами — card.wb.ru с dest надёжнее. */
  const destEff = regionDest?.trim() || fallbackDest?.trim() || "-1257786";
  const mkResult = (partial: {
    effectiveShowcaseRub: number | null;
    source: ShowcaseResolvedSource;
    apiShowcaseRub: number | null;
    apiWalletRub: number | null;
    resolutionNote: string;
    cardMeta: CardApiAttemptMeta | null;
    verificationSource: "dom_buybox" | "card_api" | "none";
    sourcePriority: string;
    sourceConflictDetected: boolean;
    sourceConflictDeltaRub: number | null;
    conflictAcceptedSource: "local_verified" | "card_api" | "none";
  }): ShowcaseOrchestratorResult => ({
    effectiveShowcaseRub: partial.effectiveShowcaseRub,
    showcasePriceRub: partial.effectiveShowcaseRub,
    priceWithSppWithoutWalletRub: null,
    source: partial.source,
    verificationSource: partial.verificationSource,
    sourcePriority: partial.sourcePriority,
    sourceConflictDetected: partial.sourceConflictDetected,
    sourceConflictDeltaRub: partial.sourceConflictDeltaRub,
    conflictAcceptedSource: partial.conflictAcceptedSource,
    verifiedLocalShowcaseRub: localVerified.showcaseRub,
    verifiedLocalWithoutWalletRub: localVerified.withoutWalletRub,
    apiShowcaseRub: partial.apiShowcaseRub,
    apiWalletRub: partial.apiWalletRub,
    resolutionNote: partial.resolutionNote,
    walletRub,
    cardMeta: partial.cardMeta,
    destEffective: destEff,
  });

  if (tryCardApi && page) {
    let pair = await fetchCardPricePairViaPageEvaluate(page, nmId, destEff);
    let cardRub = pair.showcaseRub;
    let cardWalletRub = pair.walletRub;
    if (cardRub == null) {
      await sleep(jitterMs(500, 1800));
      pair = await fetchCardPricePairViaPageEvaluate(page, nmId, destEff);
      cardRub = pair.showcaseRub;
      cardWalletRub = pair.walletRub;
    }
    if (cardRub != null) {
      const deltaRub = localVerified.showcaseRub != null ? Math.abs(localVerified.showcaseRub - cardRub) : null;
      const conflict = deltaRub != null && deltaRub > 0;
      if (localVerified.showcaseRub != null) {
        logger.warn(
          {
            tag: TAG,
            nmId,
            verifiedLocalShowcaseRub: localVerified.showcaseRub,
            cardApiShowcaseRub: cardRub,
            deltaRub,
            conflictAcceptedSource: "local_verified",
          },
          "витрина: local verified и card_api расходятся — local verified имеет приоритет",
        );
        return mkResult({
          effectiveShowcaseRub: localVerified.showcaseRub,
          source: "product_page_dom",
          apiShowcaseRub: cardRub,
          apiWalletRub: cardWalletRub,
          resolutionNote: "local_verified_preferred_over_card_api",
          cardMeta: {
            rub: cardRub,
            walletRub: cardWalletRub,
            attemptsUsed: 1,
            lastHttpStatus: 200,
            lastPath: "/cards/v4/detail",
            lastError: null,
          },
          verificationSource: localVerified.verificationSource,
          sourcePriority: "local_verified>card_api>dom_fallback",
          sourceConflictDetected: conflict,
          sourceConflictDeltaRub: deltaRub,
          conflictAcceptedSource: "local_verified",
        });
      }
      logger.info(
        {
          tag: TAG,
          nmId,
          showcaseSource: "card_api",
          showcaseRub: cardRub,
          cardWalletRub,
          walletRub,
          dest: destEff,
          domRubWhenPresent: domRub,
          localVerifiedShowcaseRub: localVerified.showcaseRub,
          note: "card_api_used_as_reference_when_local_not_verified",
        },
        "витрина: card.wb.ru по dest (региональная цена)",
      );
      return mkResult({
        effectiveShowcaseRub: cardRub,
        source: "card_api",
        apiShowcaseRub: cardRub,
        apiWalletRub: cardWalletRub,
        resolutionNote:
          domRub != null ? "card_api_preferred_over_dom_for_regional" : "page_evaluate_card_detail",
        cardMeta: {
          rub: cardRub,
          walletRub: cardWalletRub,
          attemptsUsed: 1,
          lastHttpStatus: 200,
          lastPath: "/cards/v4/detail",
          lastError: null,
        },
        verificationSource: "card_api",
        sourcePriority: "card_api>dom_fallback",
        sourceConflictDetected: conflict,
        sourceConflictDeltaRub: deltaRub,
        conflictAcceptedSource: "card_api",
      });
    }
  }

  if (!tryCardApi) {
    if (domRub != null) {
      logger.info(
        {
          tag: TAG,
          nmId,
          showcaseSource: "product_page_dom",
          showcaseRub: domRub,
          walletRub,
          parseStatus: walletDom.parseStatus,
          localVerifiedShowcaseRub: localVerified.showcaseRub,
          trustedSource: localVerified.showcaseRub != null ? "product_page_wallet_selector" : "none",
          reason: "card_api_disabled_or_batch_off",
        },
        "витрина: используем DOM price source (card API отключён)",
      );
      return mkResult({
        effectiveShowcaseRub: domRub,
        source: "product_page_dom",
        apiShowcaseRub: null,
        apiWalletRub: null,
        resolutionNote: localVerified.showcaseRub != null ? "dom_wallet_card_disabled" : "dom_price_card_disabled",
        cardMeta: null,
        verificationSource: localVerified.showcaseRub != null ? localVerified.verificationSource : "dom_buybox",
        sourcePriority: "local_dom_only",
        sourceConflictDetected: false,
        sourceConflictDeltaRub: null,
        conflictAcceptedSource: localVerified.showcaseRub != null ? "local_verified" : "none",
      });
    }
    logger.info(
      { tag: TAG, nmId, showcaseSource: "none", walletRub, reason: "card_api_disabled_or_batch_off" },
      "витрина: DOM без regular, card API отключён",
    );
    return mkResult({
      effectiveShowcaseRub: null,
      source: "none",
      apiShowcaseRub: null,
      apiWalletRub: null,
      resolutionNote: "no_dom_regular_card_disabled",
      cardMeta: null,
      verificationSource: "none",
      sourcePriority: "none",
      sourceConflictDetected: false,
      sourceConflictDeltaRub: null,
      conflictAcceptedSource: "none",
    });
  }

  logger.info(
    {
      tag: TAG,
      nmId,
      stockLevel,
      walletRub,
      hasDomPriceSource: domRub != null,
      localVerifiedShowcaseRub: localVerified.showcaseRub,
      note: "try_card_cookies_pipeline",
    },
    "витрина: запускаем card/cookies контур по dest",
  );

  const apiForCard = page?.request ?? api;

  /** Первичный fetch со страницы уже выполнен выше (при наличии page); дальше — APIRequestContext и обходы 403. */
  let cardMeta = await resolveFromCardApi(apiForCard, nmId, destEff, { maxAttempts: maxCardAttempts });

  if (cardMeta.rub == null && page && (cardMeta.lastHttpStatus === 403 || cardMeta.lastHttpStatus === 401)) {
    const retryPair = await fetchCardPricePairViaPageEvaluate(page, nmId, destEff);
    if (retryPair.showcaseRub != null) {
      logger.info(
        { tag: TAG, nmId, showcaseRub: retryPair.showcaseRub, walletRub: retryPair.walletRub, via: "page_evaluate_after_403" },
        "витрина: card.wb.ru — повторный fetch со страницы после 403 у APIRequestContext",
      );
      cardMeta = {
        rub: retryPair.showcaseRub,
        walletRub: retryPair.walletRub,
        attemptsUsed: cardMeta.attemptsUsed + 1,
        lastHttpStatus: 200,
        lastPath: "/cards/v4/detail",
        lastError: null,
      };
    }
  }

  if (cardMeta.rub == null && page) {
    const restoreCatalog = `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`;
    const rubTop = await tryShowcaseRubViaCardWbTopLevelNavigation(page, nmId, destEff, restoreCatalog);
    if (rubTop != null) {
      logger.info(
        { tag: TAG, nmId, showcaseRub: rubTop, via: "document_navigation" },
        "витрина: card.wb.ru — JSON после перехода вкладки на URL API (обход 403)",
      );
      cardMeta = {
        rub: rubTop,
        walletRub: cardMeta.walletRub ?? null,
        attemptsUsed: cardMeta.attemptsUsed + 1,
        lastHttpStatus: 200,
        lastPath: "/cards/v4/detail",
        lastError: null,
      };
    }
  }

  if (cardMeta.rub != null) {
    const deltaRub =
      localVerified.showcaseRub != null ? Math.abs(localVerified.showcaseRub - cardMeta.rub) : null;
    const conflict = deltaRub != null && deltaRub > 0;
    if (localVerified.showcaseRub != null) {
      logger.warn(
        {
          tag: TAG,
          nmId,
          verifiedLocalShowcaseRub: localVerified.showcaseRub,
          cardApiShowcaseRub: cardMeta.rub,
          deltaRub,
          conflictAcceptedSource: "local_verified",
        },
        "витрина: card_api fallback конфликтует с local verified — local verified приоритетнее",
      );
      return mkResult({
        effectiveShowcaseRub: localVerified.showcaseRub,
        source: "product_page_dom",
        apiShowcaseRub: cardMeta.rub,
        apiWalletRub: cardMeta.walletRub,
        resolutionNote: "local_verified_preferred_over_card_api_fallback",
        cardMeta,
        verificationSource: localVerified.verificationSource,
        sourcePriority: "local_verified>card_api>dom_fallback",
        sourceConflictDetected: conflict,
        sourceConflictDeltaRub: deltaRub,
        conflictAcceptedSource: "local_verified",
      });
    }
    logger.info(
      {
        tag: TAG,
        nmId,
        showcaseSource: "card_api",
        showcaseRub: cardMeta.rub,
        cardWalletRub: cardMeta.walletRub,
        walletRub,
        localVerifiedShowcaseRub: localVerified.showcaseRub,
        attempts: cardMeta.attemptsUsed,
        lastPath: cardMeta.lastPath,
      },
      "витрина: card.wb.ru (fallback — на странице не найдена DOM price source)",
    );
    return mkResult({
      effectiveShowcaseRub: cardMeta.rub,
      source: "card_api",
      apiShowcaseRub: cardMeta.rub,
      apiWalletRub: cardMeta.walletRub,
      resolutionNote: "dom_price_source_missing_used_card_api",
      cardMeta,
      verificationSource: "card_api",
      sourcePriority: "card_api>dom_fallback",
      sourceConflictDetected: conflict,
      sourceConflictDeltaRub: deltaRub,
      conflictAcceptedSource: "card_api",
    });
  }

  if (domRub != null) {
    logger.warn(
      {
        tag: TAG,
        nmId,
        showcaseSource: "product_page_dom",
        showcaseRub: domRub,
        walletRub,
        localVerifiedShowcaseRub: localVerified.showcaseRub,
        trustedSource: localVerified.showcaseRub != null ? "product_page_wallet_selector" : "none",
        lastHttpStatus: cardMeta.lastHttpStatus,
        lastError: cardMeta.lastError,
      },
      "витрина: card/cookies по dest не получен — используем DOM price source",
    );
    return mkResult({
      effectiveShowcaseRub: domRub,
      source: "product_page_dom",
      apiShowcaseRub: null,
      apiWalletRub: cardMeta.walletRub ?? null,
      resolutionNote:
        localVerified.showcaseRub != null
          ? `card_failed_dom_wallet_last_status_${cardMeta.lastHttpStatus}`
          : `card_failed_dom_price_last_status_${cardMeta.lastHttpStatus}`,
      cardMeta,
      verificationSource: localVerified.showcaseRub != null ? localVerified.verificationSource : "dom_buybox",
      sourcePriority: "dom_fallback_after_card_failure",
      sourceConflictDetected: false,
      sourceConflictDeltaRub: null,
      conflictAcceptedSource: localVerified.showcaseRub != null ? "local_verified" : "none",
    });
  }

  logger.warn(
    {
      tag: TAG,
      nmId,
      showcaseSource: "none",
      walletRub,
      localVerifiedShowcaseRub: localVerified.showcaseRub,
      lastHttpStatus: cardMeta.lastHttpStatus,
      lastError: cardMeta.lastError,
    },
    "витрина: ни DOM price source, ни card.wb.ru — СПП по витрине может быть недоступен",
  );
  return mkResult({
    effectiveShowcaseRub: null,
    source: "none",
    apiShowcaseRub: null,
    apiWalletRub: cardMeta.walletRub ?? null,
    resolutionNote: `dom_and_card_failed_last_status_${cardMeta.lastHttpStatus}`,
    cardMeta,
    verificationSource: "none",
    sourcePriority: "none",
    sourceConflictDetected: false,
    sourceConflictDeltaRub: null,
    conflictAcceptedSource: "none",
  });
}
