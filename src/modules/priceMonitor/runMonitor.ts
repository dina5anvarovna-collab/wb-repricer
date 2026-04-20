import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { regionLabelForDest } from "../../lib/wbRegions.js";
import { getSelectedRegionDests } from "../../lib/monitorPrefs.js";
import {
  getBuyerDisplayedPrice,
  resolveWalletDomBrowserKind,
  walletParserResultToBuyerDom,
  type BuyerDomResult,
} from "../wbBuyerDom/runWalletCli.js";
import {
  getWbWalletPrice,
  getWbWalletPriceBatch,
  type WalletParserResult,
} from "../../walletDom/wbWalletPriceParser.js";
import { resolveBuyerProfileDir } from "../catalogSync/syncCatalog.js";
import { resolveStockLevel, type StockLevel } from "../../lib/stockLevel.js";
import { prepareBuyerSessionForMonitor } from "../buyerSession/buyerSessionManager.js";
import { checkBuyerSession } from "../../lib/buyerSessionCheck.js";
import { resolveWbBrowserHeadless } from "../../lib/wbBrowserEnv.js";
import { isBuyerAuthDisabled, isPublicOnlyWalletParse } from "../../lib/repricerMode.js";
import {
  createEphemeralWalletProfileDir,
  removeEphemeralWalletProfileDir,
} from "../../lib/ephemeralWalletProfile.js";
import { resolveObservedBuyerPrices } from "../pricing/resolveObservedBuyerPrices.js";
import { canPersistVerifiedWalletTruth } from "../pricing/buyerVerificationCrossCheck.js";
import { decideRepricing } from "../pricing/decideRepricing.js";
import type { WalletDecisionSessionStatus } from "../pricing/walletEvidence.js";
import {
  aggregateTrustedProductSnapshot,
  buildBuyerRegionalSnapshotFromResolved,
  buildSellerSnapshotFromProduct,
  type BuyerRegionalSnapshot,
} from "../pricing/trustedProductSnapshot.js";
import {
  lastGoodSubstitutionMode,
  walletParseNumericConfidence,
  type MonitorParseContour,
} from "../../lib/repricingGuards.js";
import {
  randomPublicJitterWaitMs,
  resolvePublicBrowserHeadless,
} from "../../lib/publicBrowserRuntime.js";
import {
  buildSellerSideFromWbProduct,
  buildUnifiedObservation,
  destStringToNumber,
  toUnifiedRub,
} from "../../lib/unifiedPriceModel.js";

const EVAL_TOL_RUB = 3;

function envFlagEnabled(raw: string | undefined, defaultValue: boolean): boolean {
  const v = raw?.trim().toLowerCase() ?? "";
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

type MonitorHoldState = {
  captcha: boolean;
  stale: boolean;
  skipUpdate: boolean;
  reason: "captcha_hold" | "stale_hold" | "none";
};

export function classifyMonitorHoldState(input: {
  parseStatus: string | null | undefined;
  httpStatus: number | null;
  validation: "fresh" | "stale" | "invalid" | "unknown";
}): MonitorHoldState {
  const ps = String(input.parseStatus ?? "");
  const captcha = ps === "blocked_or_captcha" || ps === "captcha" || input.httpStatus === 498;
  const stale = input.validation === "stale" || ps === "auth_required";
  const blockCaptcha = envFlagEnabled(env.REPRICER_BUYER_BLOCK_ON_CAPTCHA, true);
  const blockStale = envFlagEnabled(env.REPRICER_BUYER_BLOCK_ON_STALE, true);
  if (captcha && blockCaptcha) {
    return { captcha: true, stale: false, skipUpdate: true, reason: "captcha_hold" };
  }
  if (stale && blockStale) {
    return { captcha: false, stale: true, skipUpdate: true, reason: "stale_hold" };
  }
  return { captcha, stale, skipUpdate: false, reason: "none" };
}

export function shouldSkipOverwriteLastGood(input: {
  walletRub: number | null;
  nonWalletRub: number | null;
}): boolean {
  if (!envFlagEnabled(env.REPRICER_BUYER_NEVER_OVERWRITE_LASTGOOD_WITH_NULL, true)) return false;
  return (
    (input.walletRub == null || !Number.isFinite(input.walletRub) || input.walletRub <= 0) &&
    (input.nonWalletRub == null || !Number.isFinite(input.nonWalletRub) || input.nonWalletRub <= 0)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSyntheticWalletFailure(
  nmId: number,
  region: string | null,
  err: unknown,
): WalletParserResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    nmId,
    url: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
    region,
    priceRegular: null,
    buyerVisiblePriceRub: null,
    priceWallet: null,
    walletLabel: null,
    walletDiscountText: null,
    inStock: null,
    parsedAt: new Date().toISOString(),
    source: "dom",
    parseStatus: "parse_failed",
    sourceConfidence: 0,
    parseMethod: "batch_fatal",
    lines: [message.slice(0, 600)],
  };
}

function walletStepNeedsRecovery(sl: StockLevel, dom: BuyerDomResult): boolean {
  const ps = dom.parseStatus ?? "";
  if (ps === "parse_failed" || ps === "blocked_or_captcha" || ps === "auth_required") {
    return true;
  }
  if (
    sl === "IN_STOCK" &&
    ps !== "loaded_wallet_confirmed" &&
    ps !== "loaded_showcase_only"
  ) {
    return true;
  }
  return false;
}

/** Query-параметр `dest` на странице карточки (может отсутствовать после SPA). */
function destParamFromUrl(href: string | null | undefined): string | null {
  if (href == null || !String(href).trim()) return null;
  try {
    return new URL(href).searchParams.get("dest");
  } catch {
    return null;
  }
}

function monitorUsesWalletBatch(): boolean {
  const v = env.REPRICER_MONITOR_WALLET_BATCH.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

function monitorSppViaCookies(): boolean {
  const v = env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

function deriveEvaluationStatus(input: {
  targetRub: number | null;
  domSuccess: boolean;
  parseStatus: string | null | undefined;
  buyerWallet: number | null;
  buyerRegular: number | null;
  walletSource: string;
  stockLevel: StockLevel;
  /** После fallback для OOS: есть цены для оценки минимума без живой витрины */
  hasUsablePrice: boolean;
}): string {
  if (input.targetRub == null || !Number.isFinite(input.targetRub)) {
    return "no_target";
  }
  const hardAuth =
    input.parseStatus === "auth_required" || input.parseStatus === "blocked_or_captcha";
  const relaxedDomOk =
    input.domSuccess ||
    (input.stockLevel === "OUT_OF_STOCK" && input.hasUsablePrice && !hardAuth);

  if (!relaxedDomOk) {
    if (input.parseStatus === "auth_required") return "auth_problem";
    if (input.parseStatus === "blocked_or_captcha") return "auth_problem";
    return "parse_failed";
  }
  const t = input.targetRub;
  const tol = EVAL_TOL_RUB;
  if (
    input.buyerWallet != null &&
    input.buyerWallet > 0 &&
    input.walletSource !== "unavailable" &&
    input.buyerWallet < t - tol
  ) {
    return "below_min";
  }
  if (
    input.parseStatus === "loaded_showcase_only" &&
    input.buyerRegular != null &&
    input.buyerRegular > 0 &&
    input.buyerRegular < t - tol
  ) {
    return "needs_review";
  }
  const skipParseFailed =
    input.stockLevel === "OUT_OF_STOCK" && input.hasUsablePrice && !hardAuth;
  if (input.parseStatus === "parse_failed" && !skipParseFailed) {
    return "parse_failed";
  }
  return "ok";
}

export async function runPriceMonitorJob(opts: {
  maxProducts?: number;
  workerId: string;
}): Promise<{ jobId: string; processed: number }> {
  const rawMax = opts.maxProducts ?? 50;
  const max =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.min(Math.floor(rawMax), 5000)
      : 50;
  const job = await prisma.syncJob.create({
    data: { type: "monitor", status: "running", meta: JSON.stringify({ workerId: opts.workerId }) },
  });

  let ephemeralProfileDir: string | null = null;
  /** Persistent профиль недоступен → как public-only для этого прогона. */
  let ephemeralBuyerFallback = false;

  try {
    let session: Awaited<ReturnType<typeof prisma.buyerSession.findFirst>> = null;
    let buyerSessionValidation: "fresh" | "stale" | "invalid" | "unknown" = "unknown";
    let profileDir = resolveBuyerProfileDir();
    if (isBuyerAuthDisabled()) {
      ephemeralProfileDir = createEphemeralWalletProfileDir();
      profileDir = ephemeralProfileDir;
      buyerSessionValidation = "unknown";
      logger.info(
        { tag: "monitor-public-only", profileDir },
        "public parse started — ephemeral browser profile (no buyer auth)",
      );
    } else {
      session = await prisma.buyerSession.findFirst({
        where: { status: "fresh", isAuthorized: true },
        orderBy: { updatedAt: "desc" },
      });
      profileDir = session?.profileDir ?? resolveBuyerProfileDir();
      logger.info({ tag: "buyer_session_loaded", profileDir }, "persistent buyer profile directory");

      const chk = await checkBuyerSession(profileDir);
      if (chk.status === "valid") {
        buyerSessionValidation = "fresh";
        logger.info(
          { tag: "buyer_session_valid", profileDir, detail: chk.detail },
          "buyer session validated — browser parsing with saved profile",
        );
      } else {
        buyerSessionValidation =
          chk.status === "stale" || chk.status === "auth_wall" || chk.status === "captcha" || chk.status === "blocked"
            ? "stale"
            : "invalid";
        ephemeralBuyerFallback = true;
        logger.warn(
          {
            tag: "buyer_session_stale",
            profileDir,
            checkStatus: chk.status,
            detail: chk.detail,
          },
          "buyer session not usable — fallback to ephemeral public-style parse (no auto-login)",
        );
        ephemeralProfileDir = createEphemeralWalletProfileDir();
        profileDir = ephemeralProfileDir;
      }
    }
    const regionDests = await getSelectedRegionDests();
    const envWalletDest = env.REPRICER_WALLET_DEST.trim() || null;
    /** Пустой список в настройках + REPRICER_WALLET_DEST → один проход с этим dest (иначе URL без dest = один склад для всех «регионов»). */
    const rawDestList =
      regionDests.length > 0 ? regionDests : envWalletDest ? [envWalletDest] : [null];
    const destList = rawDestList.map((d) =>
      d == null || typeof d !== "string" ? null : d.trim() || null,
    );
    /** Первый ненулевой dest совпадает с первым шагом плана (для last* на WbProduct). */
    const primaryDest =
      (destList.find((x) => x != null) ?? envWalletDest ?? null)?.trim() || null;

    const products = await prisma.wbProduct.findMany({
      where: { isActive: true, buyerParseEnabled: true },
      take: max,
      orderBy: { updatedAt: "desc" },
      include: {
        fixedPrices: { orderBy: { effectiveFrom: "desc" }, take: 1 },
        minPriceRule: true,
      },
    });

    if (!isBuyerAuthDisabled() && !ephemeralBuyerFallback) {
      await prepareBuyerSessionForMonitor();
    }
    const sessionStatusForDecision: WalletDecisionSessionStatus = isBuyerAuthDisabled()
      ? "unknown"
      : session?.status === "fresh" && !ephemeralBuyerFallback
        ? "fresh"
        : buyerSessionValidation === "stale"
          ? "stale"
          : "invalid";

    const parseStats = {
      publicDom: 0,
      popupDom: 0,
      unknown: 0,
      authWall: 0,
      captcha: 0,
      safeModeLastGood: 0,
      browserRetry: 0,
      publicFallback: 0,
    };

    const stepsTotal = products.length * destList.length;
    const useWalletBatch = monitorUsesWalletBatch() && stepsTotal > 0;
    const sppViaCookies =
      monitorSppViaCookies() && !isBuyerAuthDisabled() && !ephemeralBuyerFallback;
    logger.info(
      {
        products: products.length,
        regions: destList.length,
        stepsTotal,
        walletMode: useWalletBatch ? "single_browser_batch" : "spawn_per_nm_region",
        showcaseForSpp: sppViaCookies
          ? "card_wb_ru_cookies_independent_of_batch"
          : primaryDest
            ? "card_wb_ru_per_dest_when_region_set"
            : "dom_only",
        env_REPRICER_MONITOR_WALLET_BATCH: env.REPRICER_MONITOR_WALLET_BATCH,
        env_REPRICER_MONITOR_SPP_VIA_COOKIES: env.REPRICER_MONITOR_SPP_VIA_COOKIES,
        note: useWalletBatch
          ? "batch: один контекст; DOM с ?dest= на шаг; при непустом dest всегда card.wb.ru по этому dest (не только при SPP_VIA_COOKIES)"
          : "spawn: CLI на шаг с --region=; при заданном regionDest включается showcase/card как в батче",
      },
      "monitor job start",
    );

    let processed = 0;
    let domSuccessForSession = false;

    type ProductRow = (typeof products)[number];
    const regionalSnapshotsByProduct = new Map<string, BuyerRegionalSnapshot[]>();

    const defaultMonitorContour: MonitorParseContour =
      isBuyerAuthDisabled() || ephemeralBuyerFallback ? "public_fallback" : "browser_primary";
    const persistentBuyerProfileAbsolute =
      !isBuyerAuthDisabled() && !ephemeralBuyerFallback
        ? (session?.profileDir ?? resolveBuyerProfileDir())
        : null;

    async function persistMonitorStep(
      p: ProductRow,
      walletDest: string | null,
      dom: BuyerDomResult,
      pauseAfter: boolean,
      monitorParseContour?: MonitorParseContour,
    ): Promise<void> {
      const contourEff = monitorParseContour ?? defaultMonitorContour;
      const destKey = walletDest?.trim() || null;
      const fixed = p.fixedPrices[0]?.targetPrice ?? null;
      const ruleMin = p.minPriceRule?.minAllowedFinalPrice ?? null;
      const targetRub =
        ruleMin != null && Number.isFinite(ruleMin)
          ? ruleMin
          : fixed != null && Number.isFinite(fixed)
            ? fixed
            : null;
      const diffSeller =
        targetRub != null && p.sellerPrice != null ? p.sellerPrice - targetRub : null;

      const stockLevel = resolveStockLevel(p.stock, dom.inStock ?? null);

      let status: "ok" | "warning" | "error" = "ok";
      let errMsg: string | null = null;

      const parseStatus = dom.parseStatus ?? null;
      const parseConfidence = dom.sourceConfidence ?? null;
      const parseMethod = dom.parseMethod ?? null;
      const rawHttpStatus =
        typeof (dom as { httpStatus?: unknown }).httpStatus === "number"
          ? Math.round((dom as { httpStatus?: number }).httpStatus ?? 0)
          : typeof (dom as { responseStatus?: unknown }).responseStatus === "number"
            ? Math.round((dom as { responseStatus?: number }).responseStatus ?? 0)
            : (dom.error?.includes("498") ? 498 : null);
      const holdState = classifyMonitorHoldState({
        parseStatus,
        httpStatus: rawHttpStatus,
        validation:
          (dom as { validation?: unknown }).validation === "stale"
            ? "stale"
            : sessionStatusForDecision,
      });
      const tier = dom.priceParseSource ?? null;
      if (tier === "public_dom") parseStats.publicDom += 1;
      else if (tier === "popup_dom") parseStats.popupDom += 1;
      else parseStats.unknown += 1;
      if (parseStatus === "auth_required") parseStats.authWall += 1;
      if (parseStatus === "blocked_or_captcha") parseStats.captcha += 1;
      const lastRegionSnapshot = await prisma.priceSnapshot.findFirst({
        where: { productId: p.id, regionDest: destKey },
        orderBy: { parsedAt: "desc" },
        select: { buyerWalletPrice: true, buyerRegularPrice: true },
      });
      const resolved = resolveObservedBuyerPrices({
        dom,
        stockLevel,
        expectedNmId: p.nmId,
        expectedDest: destKey,
        sessionStatus: sessionStatusForDecision,
        monitorBatchDestCount: destList.length,
        fallbackContext: {
          discountedPriceRub: p.discountedPriceRub,
          targetRub,
          sellerPrice: p.sellerPrice,
          lastSnapshotWalletRub: lastRegionSnapshot?.buyerWalletPrice ?? null,
          lastSnapshotRegularRub: lastRegionSnapshot?.buyerRegularPrice ?? null,
          lastKnownShowcaseRub: p.lastKnownShowcaseRub,
          lastKnownWalletRub: p.lastKnownWalletRub,
          lastRegularObservedRub: p.lastRegularObservedRub,
          lastWalletObservedRub: p.lastWalletObservedRub,
          walletRubLastGood: p.walletRubLastGood,
          nonWalletRubLastGood: p.nonWalletRubLastGood,
        },
      });
      let persistVerifiedWallet = canPersistVerifiedWalletTruth({
        verification: resolved.buyerPriceVerification,
        blockedBySafetyRule: resolved.blockedBySafetyRule,
        regionPriceAmbiguous: resolved.regionPriceAmbiguous ?? null,
        parseStatus: parseStatus ?? "",
      });
      let buyerWallet = resolved.buyerWallet;
      let showcaseRub = resolved.showcaseRub;
      let buyerRegular = resolved.buyerRegular;

      const parseRecovered =
        dom.success &&
        showcaseRub != null &&
        showcaseRub > 0 &&
        parseStatus !== "parse_failed" &&
        parseStatus !== "auth_required" &&
        parseStatus !== "blocked_or_captcha";

      const popupParsed =
        tier === "popup_dom" || ((dom as any).popupOpened === true && tier !== "popup_dom");
      const walletMarkerDetected =
        parseStatus === "loaded_wallet_confirmed" ||
        (tier === "public_dom" &&
          parseStatus !== "parse_failed" &&
          parseStatus !== "loaded_showcase_only");

      const lastGoodMode = lastGoodSubstitutionMode(p.walletRubLastGoodAt ?? null);
      const lastGoodAgeMin =
        p.walletRubLastGoodAt != null
          ? Math.max(0, (Date.now() - p.walletRubLastGoodAt.getTime()) / 60_000)
          : null;
      const allowFailOpenWithLastGood = envFlagEnabled(env.REPRICER_BUYER_FAIL_OPEN_WITH_LASTGOOD, true);
      const holdWindowMinutes =
        holdState.reason === "captcha_hold"
          ? env.REPRICER_BUYER_CAPTCHA_HOLD_MINUTES
          : env.REPRICER_BUYER_STALE_HOLD_MINUTES;
      const lastGoodFresh =
        p.walletRubLastGood != null &&
        Number.isFinite(p.walletRubLastGood) &&
        p.walletRubLastGood > 0 &&
        (lastGoodAgeMin == null || lastGoodAgeMin <= env.REPRICER_BUYER_LASTGOOD_TTL_MINUTES);
      let usedLastGoodFallback = false;
      let protectOnlyLastGood = false;
      let skipUpdate = false;
      if (holdState.reason === "captcha_hold") {
        logger.warn({ nmId: p.nmId, dest: destKey, parseStatus, httpStatus: rawHttpStatus }, "captcha detected → HOLD");
        skipUpdate = true;
      } else if (holdState.reason === "stale_hold") {
        logger.warn({ nmId: p.nmId, dest: destKey, parseStatus, validation: sessionStatusForDecision }, "stale session → HOLD");
        skipUpdate = true;
      }
      if (skipUpdate && allowFailOpenWithLastGood && lastGoodFresh && (lastGoodAgeMin == null || lastGoodAgeMin <= holdWindowMinutes)) {
        usedLastGoodFallback = true;
        showcaseRub = Math.round(p.walletRubLastGood!);
        buyerWallet = Math.round(p.walletRubLastGood!);
        buyerRegular =
          p.nonWalletRubLastGood != null && Number.isFinite(p.nonWalletRubLastGood) && p.nonWalletRubLastGood > 0
            ? Math.round(p.nonWalletRubLastGood)
            : buyerRegular;
        logger.warn({ nmId: p.nmId, dest: destKey, lastGoodAgeMin }, "using last good snapshot");
      }

      if (
        isPublicOnlyWalletParse() &&
        !parseRecovered &&
        p.walletRubLastGood != null &&
        Number.isFinite(p.walletRubLastGood) &&
        p.walletRubLastGood > 0 &&
        lastGoodMode !== "none"
      ) {
        usedLastGoodFallback = true;
        protectOnlyLastGood = lastGoodMode === "protect_only";
        showcaseRub = Math.round(p.walletRubLastGood);
        buyerWallet = Math.round(p.walletRubLastGood);
        parseStats.safeModeLastGood += 1;
        logger.warn(
          {
            nmId: p.nmId,
            tag: "public-parse",
            rub: showcaseRub,
            lastGoodMode,
          },
          protectOnlyLastGood
            ? "safe mode — last good used (protect-only TTL 2–24h)"
            : "safe mode enabled — last known good wallet value used",
        );
      }

      if (parseRecovered && isPublicOnlyWalletParse()) {
        logger.info({ nmId: p.nmId, tag: "public-parse", parseStatus }, "public dom parsed — wallet/showcase recovered");
      }
      const snapshotWalletSource = resolved.walletSource;
      const buyerRegularSource = resolved.buyerRegularSource;
      const fb = resolved.fallback;
      const { showcaseEff, cookieShowcase, apiWalletRub, domRegular, sppWoWallet } = resolved.signals;
      let priceWithoutWalletRub = resolved.priceWithoutWalletRub;
      if (priceWithoutWalletRub == null && buyerRegular != null) {
        priceWithoutWalletRub = buyerRegular;
      }

      const partialDom =
        parseStatus === "loaded_showcase_only" ||
        (!parseRecovered && dom.success && !usedLastGoodFallback);

      let walletNumericConfidence = walletParseNumericConfidence({
        priceParseSource: tier,
        parseStatus,
        walletMarkerDetected,
        popupParsed,
        partialDom,
        monitorParseContour: contourEff,
      });
      if (protectOnlyLastGood && usedLastGoodFallback) {
        walletNumericConfidence = Math.min(walletNumericConfidence, 0.45);
      } else if (usedLastGoodFallback) {
        walletNumericConfidence = Math.min(walletNumericConfidence, 0.55);
      }

      const hardAuth =
        parseStatus === "auth_required" || parseStatus === "blocked_or_captcha";
      const hasUsablePrice = resolved.hasUsablePrice || usedLastGoodFallback;
      const parsedAtMs = Date.parse(dom.parsedAt ?? "");
      const ageMinutes =
        Number.isFinite(parsedAtMs) && parsedAtMs > 0
          ? Math.max(0, (Date.now() - parsedAtMs) / 60_000)
          : null;
      const pricingDecision = decideRepricing({
        sellerPriceRub: p.sellerPrice ?? null,
        floorRub: targetRub,
        walletEvidence: resolved.walletEvidence,
        sessionStatus: sessionStatusForDecision,
        stock: stockLevel,
        freshness: {
          isFresh:
            !hardAuth &&
            parseStatus !== "parse_failed" &&
            parseStatus !== "loaded_no_price" &&
            (ageMinutes == null || ageMinutes <= env.REPRICER_BUYER_SNAPSHOT_TTL_MINUTES),
          ageMinutes,
        },
      });
      const repricingAllowed = pricingDecision.action === "enforce_now";
      persistVerifiedWallet = persistVerifiedWallet && repricingAllowed;

      const noShowcaseLive = showcaseRub == null;
      const noDomRegularSignal = domRegular == null && showcaseEff == null && buyerRegular == null;

      if (hardAuth) {
        status = "error";
        errMsg = dom.error ?? "auth";
      } else if (!dom.success) {
        if (stockLevel === "OUT_OF_STOCK" && hasUsablePrice) {
          status = "ok";
          errMsg = null;
        } else if (stockLevel === "OUT_OF_STOCK") {
          status = "warning";
          errMsg = null;
        } else {
          status = "error";
          errMsg = dom.error ?? "dom failed";
        }
      } else {
        errMsg = null;
        if (repricingAllowed) {
          status = "ok";
        } else if (stockLevel === "OUT_OF_STOCK" && hasUsablePrice) {
          status = "ok";
        } else if (hasUsablePrice) {
          status = "warning";
        } else {
          status = "warning";
        }
      }

      if (stockLevel === "IN_STOCK" && noShowcaseLive && noDomRegularSignal) {
        logger.warn(
          { tag: "monitor-pricing", nmId: p.nmId, stockLevel },
          "витрина: товар в наличии, обычная цена в DOM не найдена",
        );
      } else if (stockLevel === "IN_STOCK" && dom.success && !repricingAllowed) {
        logger.warn(
          {
            tag: "monitor-pricing",
            nmId: p.nmId,
            dest: destKey,
            verificationStatus: resolved.buyerPriceVerification.verificationStatus,
            verificationReason: resolved.buyerPriceVerification.verificationReason,
            verificationMethod: resolved.buyerPriceVerification.verificationMethod,
            trustedSource: resolved.trustedSource,
            repricingAllowed,
            repricingAllowedReason: `${resolved.repricingAllowedReason};decision=${pricingDecision.action}`,
            pricingDecision: pricingDecision.action,
            parseStatus,
            topPriceFound: resolved.topPriceFound,
            priceParseMode: resolved.priceParseMode,
          },
          "buyer wallet not trusted enough for repricing",
        );
      } else if (stockLevel === "OUT_OF_STOCK" && noShowcaseLive) {
        logger.info(
          { tag: "monitor-pricing", nmId: p.nmId, stockLevel, expectedCase: "oos_no_showcase_dom" },
          "витрина: нет остатка — отсутствие обычной цены на карточке ожидаемо",
        );
      }

      const sessionDomTick =
        dom.success &&
        (parseStatus === "loaded_wallet_confirmed" || parseStatus === "loaded_showcase_only");
      const oosRecoverTick = stockLevel === "OUT_OF_STOCK" && hasUsablePrice && !hardAuth;
      if (sessionDomTick || oosRecoverTick) {
        domSuccessForSession = true;
      }

      const diffWallet = targetRub != null && buyerWallet != null ? buyerWallet - targetRub : null;
      const walletRegionLabel = destKey ? regionLabelForDest(destKey) : null;

      const evaluationBase = deriveEvaluationStatus({
        targetRub,
        domSuccess: dom.success || usedLastGoodFallback,
        parseStatus,
        buyerWallet,
        buyerRegular,
        walletSource: snapshotWalletSource,
        stockLevel,
        hasUsablePrice,
      });
      let evaluationStatus =
        stockLevel === "IN_STOCK" &&
        dom.success &&
        !hardAuth &&
        !repricingAllowed &&
        evaluationBase === "ok"
          ? "buyer_unverified"
          : evaluationBase;
      if (pricingDecision.status === "safe_hold" && stockLevel === "IN_STOCK") {
        evaluationStatus =
          pricingDecision.action === "skip_conflict"
            ? "wallet_source_unavailable_safe_hold"
            : pricingDecision.action === "skip_stale"
              ? "buyer_unverified"
              : "wallet_source_unavailable_safe_hold";
      }

      if (parseRecovered && parseStatus === "loaded_showcase_only") {
        evaluationStatus = "partial";
      }
      if (usedLastGoodFallback) {
        evaluationStatus =
          lastGoodMode === "full" ? "last_good_used" : "wallet_source_unavailable_safe_hold";
      }
      if (skipUpdate) {
        evaluationStatus = "wallet_source_unavailable_safe_hold";
        status = "warning";
        errMsg = holdState.reason;
      }

      const sellerBasePriceRub =
        p.sellerPrice != null && Number.isFinite(p.sellerPrice) ? Math.round(p.sellerPrice) : null;
      const canonicalBuyerWalletRub =
        persistVerifiedWallet && showcaseRub != null && showcaseRub > 0 ? Math.round(showcaseRub) : null;
      const sellerCabinetRegular = toUnifiedRub(p.discountedPriceRub ?? p.sellerPrice ?? null);
      const unifiedPrice = buildUnifiedObservation(
        buildSellerSideFromWbProduct(p),
        {
          showcaseRub: toUnifiedRub(canonicalBuyerWalletRub),
          walletRub: toUnifiedRub(canonicalBuyerWalletRub),
          nonWalletRub: toUnifiedRub(priceWithoutWalletRub),
          priceRegular: sellerCabinetRegular,
        },
        {
          region: regionLabelForDest(destKey),
          dest: destStringToNumber(destKey),
        },
      );
      const detailJson = JSON.stringify({
        unifiedPrice,
        parseStatus,
        parseMethod,
        monitorParseContour: contourEff,
        stockLevel,
        sessionStatus: sessionStatusForDecision,
        evaluationStatus,
        diffSellerVsTarget: diffSeller,
        diffWalletVsTarget: diffWallet,
        buyerRegularSource,
        usedFallback: fb.usedFallback,
        fallbackChain: fb.fallbackChain,
        sellerBasePriceRub,
        repricingAllowed,
        repricingAllowedReason: `${resolved.repricingAllowedReason};decision=${pricingDecision.action}`,
        pricingDecision: pricingDecision.action,
        decisionStatus: pricingDecision.status,
        blockedBySafetyRule: resolved.blockedBySafetyRule,
        basePriceRub: resolved.basePriceRub,
        sellerDiscountPriceRub: resolved.sellerDiscountPriceRub,
        sppRub: resolved.sppRub,
        sppCalcSource: resolved.sppCalcSource,
        sppCalcReason: resolved.sppCalcReason,
        walletPriceRub: resolved.walletPriceRub,
        trustedSource: resolved.trustedSource,
        confidence: resolved.confidence,
        verificationSource: resolved.verificationSource,
        sourcePriority: resolved.sourcePriority,
        sourceConflictDetected: resolved.sourceConflictDetected,
        regionalVerificationStatus: resolved.buyerPriceVerification.verificationStatus,
        buyerPriceVerification: resolved.buyerPriceVerification,
        showcasePriceRub: dom.showcasePriceRub ?? null,
        priceWithSppWithoutWalletRub: dom.priceWithSppWithoutWalletRub ?? null,
        resolvedShowcasePriceRub: resolved.showcasePriceRub,
        resolvedPriceWithSppWithoutWalletRub: resolved.priceWithSppWithoutWalletRub,
        showcaseRub,
        priceWithoutWalletRub,
        walletDiscountRub: resolved.walletDiscountRub,
        walletDiscountPercent: resolved.walletDiscountPercent,
        oldPriceRub: resolved.oldPriceRub,
        sppPercent: resolved.sppPercent,
        finalVisibleRub: resolved.finalVisibleRub,
        sourceConfidence: resolved.sourceConfidence,
        priceParseMode: resolved.priceParseMode,
        topPriceFound: resolved.topPriceFound,
        showcaseRubEffective: showcaseEff,
        showcaseResolvedSource: dom.showcaseResolvedSource ?? null,
        showcaseResolutionNote: dom.showcaseResolutionNote ?? null,
        showcaseApiRub: dom.showcaseApiRub ?? null,
        apiWalletRub,
        showcaseRubFromCookies: cookieShowcase,
        domRegularRubDebug: domRegular,
        cardApiRubDebug: dom.showcaseApiRub ?? null,
        /** Совпадает с колонкой снимка; для выгрузок из detailJson. */
        snapshotRegionDest: destKey,
        /** Фактический URL вкладки после парсинга. */
        browserUrlAfterParse: dom.browserUrlAfterParse ?? null,
        /** `dest` в адресе после загрузки (если SPA не выкинула параметр). */
        destInBrowserUrl: destParamFromUrl(dom.browserUrlAfterParse),
        /** URL/nmId совпали с ожиданиями шага. */
        destApplied: resolved.destApplied,
        /** Реальный сигнал применения региона (не только URL). */
        regionConfirmed: resolved.regionConfirmed,
        regionDomConfirmed: resolved.regionDomConfirmed,
        regionConfirmedByRequest: resolved.regionConfirmedByRequest,
        regionConfirmedByStableReload: resolved.regionConfirmedByStableReload,
        /** URL совпал, но сигналов применения региона нет. */
        destAppliedButNotConfirmed: resolved.destAppliedButNotConfirmed,
        /** Неоднозначность выявлена после batch-сравнения dest. */
        regionPriceAmbiguous: resolved.regionPriceAmbiguous,
        walletPriceFirstRead: resolved.walletPriceFirstRead,
        walletPriceSecondRead: resolved.walletPriceSecondRead,
        finalRegionConfidence: resolved.finalRegionConfidence,
        finalWalletConfidence: resolved.finalWalletConfidence,
        repricingDecisionSource: resolved.repricingDecisionSource,
        priceParseSource: tier,
        /** Marker доставки/локации на странице (если удалось). */
        locationMarker: (dom as any).locationMarker ?? null,
        /** Сигнатура price block для отладки гидратации/смены региона. */
        priceBlockSignature: (dom as any).priceBlockSignature ?? null,
        /** Попап детализации цены (preferred подтверждение региона). */
        popupOpened: (dom as any).popupOpened ?? null,
        popupWalletRub: (dom as any).popupWalletRub ?? null,
        popupWithoutWalletRub: (dom as any).popupWithoutWalletRub ?? null,
        /** Склад WB в запросах card.wb.ru на этом шаге (региональная витрина). */
        showcaseQueryDest: dom.showcaseQueryDest ?? null,
        uiNote:
          "Подпись доставки в шапке сайта (напр. район Москвы) — профиль покупателя; не равна складу WB. Склад смотрите в snapshotRegionDest / showcaseQueryDest.",
        usedLastGoodFallback,
        safeMode: usedLastGoodFallback,
        publicOnly: isPublicOnlyWalletParse(),
        walletNumericConfidence,
        lastGoodSubstitutionMode: lastGoodMode,
        protectOnlyLastGood,
        walletEvidence: resolved.walletEvidence,
        walletConfirmed: dom.walletConfirmed === true,
        parserWalletEvidence: dom.walletEvidence ?? null,
        parserWalletRub: dom.walletRub ?? null,
        parserNonWalletRub: dom.nonWalletRub ?? null,
        batchMonitorDestCount: destList.length,
        batchMultiDestPending: destList.length > 1,
      });

      const preventOverwriteWithNull = envFlagEnabled(
        env.REPRICER_BUYER_NEVER_OVERWRITE_LASTGOOD_WITH_NULL,
        true,
      );
      const skipOverwriteLastGood =
        preventOverwriteWithNull &&
        shouldSkipOverwriteLastGood({
          walletRub: canonicalBuyerWalletRub,
          nonWalletRub: priceWithoutWalletRub,
        });
      if (skipOverwriteLastGood) {
        logger.warn({ nmId: p.nmId, dest: destKey }, "skip overwrite lastGood");
      }
      if (skipUpdate || skipOverwriteLastGood) {
        const isPrimaryHold = destKey === primaryDest || (primaryDest == null && destKey == null);
        if (isPrimaryHold) {
          await prisma.wbProduct.update({
            where: { id: p.id },
            data: {
              safeModeHold: true,
              lastEvaluationStatus: "wallet_source_unavailable_safe_hold",
              lastWalletParseStatus: parseStatus,
              lastMonitorAt: new Date(),
              lastMonitorRegionDest: destKey,
            },
          });
        }
        processed += 1;
        if (pauseAfter && env.REPRICER_MONITOR_BATCH_PAUSE_MS > 0) {
          await new Promise((r) => setTimeout(r, env.REPRICER_MONITOR_BATCH_PAUSE_MS));
        }
        return;
      }

      await prisma.priceSnapshot.create({
        data: {
          productId: p.id,
          nmId: p.nmId,
          sellerPrice: p.sellerPrice,
          sellerDiscountPctSnapshot: p.sellerDiscount ?? null,
          priceRegular: dom.priceRegular ?? null,
          showcaseRub: canonicalBuyerWalletRub,
          walletRub: canonicalBuyerWalletRub,
          nonWalletRub: priceWithoutWalletRub,
          buyerRegularPrice: priceWithoutWalletRub,
          buyerWalletPrice: canonicalBuyerWalletRub,
          walletConfirmed: dom.walletConfirmed === true,
          walletEvidence: dom.walletEvidence ?? null,
          sellerDiscountedSnapshotRub: p.discountedPriceRub,
          walletSource: snapshotWalletSource,
          fixedTargetPrice: targetRub,
          diffSellerVsTarget: diffSeller,
          diffWalletVsTarget: diffWallet,
          regionDest: destKey,
          regionLabel: walletRegionLabel,
          syncJobId: job.id,
          status,
          errorMessage: errMsg,
          parseConfidence: walletNumericConfidence,
          parseMethod: parseMethod,
          walletParseStatus: parseStatus,
          evaluationStatus,
          detailJson,
        },
      });
      processed += 1;

      const regional = buildBuyerRegionalSnapshotFromResolved({
        nmId: p.nmId,
        dest: destKey,
        resolved,
        parseError: errMsg,
        inStock: dom.inStock ?? null,
        timestampIso: new Date().toISOString(),
      });
      const list = regionalSnapshotsByProduct.get(p.id) ?? [];
      list.push(regional);
      regionalSnapshotsByProduct.set(p.id, list);

      const isPrimary = destKey === primaryDest || (primaryDest == null && destKey == null);
      if (isPrimary) {
        await prisma.wbProduct.update({
          where: { id: p.id },
          data: {
            lastMonitorAt: new Date(),
            lastMonitorRegionDest: destKey,
            lastParseConfidence: walletNumericConfidence,
            lastWalletParseStatus: parseStatus,
            lastEvaluationStatus: evaluationStatus,
            ...(stockLevel === "IN_STOCK" ? { lastSeenInStock: new Date() } : {}),
            ...(parseRecovered &&
            showcaseRub != null &&
            showcaseRub > 0 &&
            persistVerifiedWallet
              ? {
                  lastWalletObservedRub: showcaseRub,
                  lastKnownShowcaseRub: Math.round(showcaseRub),
                  lastKnownWalletRub: canonicalBuyerWalletRub ?? null,
                  lastPriceSeenAt: new Date(),
                  lastPriceSource: buyerRegularSource,
                  walletRubLastGood: Math.round(showcaseRub),
                  walletRubLastGoodAt: new Date(),
                  sourceLastGood: tier ?? "public_dom",
                  parseStatusLastGood: parseStatus ?? null,
                  walletConfidenceLastGood: walletNumericConfidence,
                  safeModeHold: false,
                  ...(priceWithoutWalletRub != null && priceWithoutWalletRub > 0
                    ? { nonWalletRubLastGood: Math.round(priceWithoutWalletRub) }
                    : {}),
                }
              : {}),
            ...(usedLastGoodFallback && showcaseRub != null && showcaseRub > 0
              ? {
                  lastWalletObservedRub: showcaseRub,
                  lastKnownShowcaseRub: Math.round(showcaseRub),
                  lastKnownWalletRub: null,
                  lastPriceSeenAt: new Date(),
                  lastPriceSource: "last_good",
                  safeModeHold: true,
                }
              : {}),
            ...(priceWithoutWalletRub != null && priceWithoutWalletRub > 0
              ? { lastRegularObservedRub: priceWithoutWalletRub }
              : {}),
            ...(dom.priceRegular != null &&
            Number.isFinite(dom.priceRegular) &&
            dom.priceRegular > 0
              ? { lastPriceRegularObservedRub: Math.round(dom.priceRegular) }
              : {}),
          },
        });
      }

      if (pauseAfter && env.REPRICER_MONITOR_BATCH_PAUSE_MS > 0) {
        await new Promise((r) => setTimeout(r, env.REPRICER_MONITOR_BATCH_PAUSE_MS));
      }
    }

    const planned: { p: ProductRow; walletDest: string | null }[] = [];
    for (const p of products) {
      for (const d of destList) {
        /** null в списке регионов (редко) — подставляем dest из .env, иначе карточка без ?dest= даёт одинаковые цены. */
        const wd = (d ?? envWalletDest ?? null)?.trim() || null;
        planned.push({ p, walletDest: wd });
      }
    }

    if (useWalletBatch) {
      const headlessEff = resolveWbBrowserHeadless();
      logger.info(
        {
          tag: "browser_parse_started",
          profileDir,
          steps: planned.length,
          headless: headlessEff,
          ephemeralFallback: ephemeralBuyerFallback,
          persistentRetryDir: persistentBuyerProfileAbsolute ?? null,
        },
        "wallet batch DOM parse",
      );
      let raw: WalletParserResult[];
      try {
        raw = await getWbWalletPriceBatch(
          {
            userDataDir: profileDir,
            headless: headlessEff,
            browser: resolveWalletDomBrowserKind(),
          },
          planned.map((x) => ({
            nmId: x.p.nmId,
            region: x.walletDest,
            cabinetStock: x.p.stock,
          })),
          {
            interStepDelayMs: env.REPRICER_MONITOR_BATCH_INTER_STEP_MS,
            fetchShowcaseWithCookies:
              isBuyerAuthDisabled() || ephemeralBuyerFallback ? false : sppViaCookies,
            cardDetailFallbackDest: env.REPRICER_WALLET_DEST.trim() || null,
            maxCardApiAttempts: env.REPRICER_MONITOR_CARD_API_MAX_ATTEMPTS,
          },
        );
        logger.info(
          { tag: "browser_parse_success", steps: planned.length, profileDir },
          "wallet batch parse finished",
        );
      } catch (e) {
        logger.error(
          {
            tag: "browser_parse_failed",
            err: e instanceof Error ? e.message : String(e),
          },
          "wallet batch threw — synthetic parse_failed per step + per-SKU recovery",
        );
        raw = planned.map((pr) =>
          makeSyntheticWalletFailure(pr.p.nmId, pr.walletDest, e),
        );
      }

      for (let i = 0; i < planned.length; i += 1) {
        const row = planned[i]!;
        let result = raw[i]!;
        let dom = walletParserResultToBuyerDom(result);
        let contour: MonitorParseContour = defaultMonitorContour;

        let stockLevel = resolveStockLevel(row.p.stock, dom.inStock ?? null);
        let needs = walletStepNeedsRecovery(stockLevel, dom);

        if (needs && persistentBuyerProfileAbsolute) {
          logger.info(
            {
              tag: "browser_parse_attempt",
              nmId: row.p.nmId,
              dest: row.walletDest,
              attempt: 2,
            },
            "browser parse retry single card",
          );
          await sleep(env.REPRICER_MONITOR_BATCH_INTER_STEP_MS + randomPublicJitterWaitMs());
          try {
            const r2 = await getWbWalletPrice({
              userDataDir: persistentBuyerProfileAbsolute,
              nmId: row.p.nmId,
              region: row.walletDest ?? undefined,
              headless: headlessEff,
              fetchShowcaseWithCookies:
                isBuyerAuthDisabled() || ephemeralBuyerFallback ? false : sppViaCookies,
              applyPublicBrowserEnv: false,
              browser: resolveWalletDomBrowserKind(),
            });
            dom = walletParserResultToBuyerDom(r2);
            result = r2;
            contour = "browser_retry";
            parseStats.browserRetry += 1;
            stockLevel = resolveStockLevel(row.p.stock, dom.inStock ?? null);
            needs = walletStepNeedsRecovery(stockLevel, dom);
          } catch (re) {
            logger.warn(
              {
                tag: "browser_parse_retry",
                nmId: row.p.nmId,
                err: re instanceof Error ? re.message : String(re),
              },
              "browser parse retry failed",
            );
          }
        }

        if (needs) {
          const ephem = createEphemeralWalletProfileDir();
          try {
            logger.warn(
              {
                tag: "browser_parse_fallback_public",
                nmId: row.p.nmId,
                dest: row.walletDest,
              },
              "public parse fallback (ephemeral profile + public browser env)",
            );
            const pubHl = resolvePublicBrowserHeadless(undefined);
            const r3 = await getWbWalletPrice({
              userDataDir: ephem,
              nmId: row.p.nmId,
              region: row.walletDest ?? undefined,
              headless: pubHl.headless ?? headlessEff,
              fetchShowcaseWithCookies: false,
              applyPublicBrowserEnv: true,
              browser: resolveWalletDomBrowserKind(),
            });
            dom = walletParserResultToBuyerDom(r3);
            contour = "public_fallback";
            parseStats.publicFallback += 1;
          } catch (fe) {
            logger.warn(
              {
                tag: "browser_parse_failed",
                nmId: row.p.nmId,
                err: fe instanceof Error ? fe.message : String(fe),
              },
              "public fallback parse failed — persisting last browser result",
            );
          } finally {
            removeEphemeralWalletProfileDir(ephem);
          }
        }

        await persistMonitorStep(row.p, row.walletDest, dom, false, contour);
      }
    } else {
      for (const row of planned) {
        const dom = await getBuyerDisplayedPrice({
          nmId: row.p.nmId,
          profileDir,
          regionDest: row.walletDest,
          timeoutMs: env.REPRICER_MONITOR_WALLET_TIMEOUT_MS,
          fetchShowcaseWithCookies:
            isBuyerAuthDisabled() || ephemeralBuyerFallback
              ? false
              : sppViaCookies || Boolean(row.walletDest?.trim()),
        });
        await persistMonitorStep(row.p, row.walletDest, dom, true);
      }
    }

    for (const p of products) {
      const regional = regionalSnapshotsByProduct.get(p.id) ?? [];
      const sellerSnapshot = buildSellerSnapshotFromProduct(p);
      const trusted = aggregateTrustedProductSnapshot({
        nmId: p.nmId,
        seller: sellerSnapshot,
        regional,
        totalRegionsCount: destList.length,
        minVerifiedRegions: Math.max(1, env.REPRICER_MIN_VALID_REGIONS_FOR_ENFORCE),
      });
      await prisma.wbProduct.update({
        where: { id: p.id },
        data: {
          lastEvaluationStatus:
            trusted.frontStatus === "VERIFIED"
              ? "trusted_verified"
              : trusted.frontStatus === "PARTIAL"
                ? "trusted_partial"
                : "trusted_unverified",
          ...(trusted.aggregatedShowcaseWithWalletRub != null &&
          trusted.aggregatedPriceWithSppRub != null &&
          trusted.frontStatus !== "UNVERIFIED"
            ? {
                lastWalletObservedRub: trusted.aggregatedShowcaseWithWalletRub,
                lastRegularObservedRub: trusted.aggregatedPriceWithSppRub,
                lastKnownShowcaseRub: trusted.aggregatedShowcaseWithWalletRub,
                lastPriceSeenAt: new Date(),
                lastPriceSource: trusted.verificationSource ?? "trusted_aggregate",
              }
            : {}),
        },
      });
    }

    if (!isBuyerAuthDisabled() && domSuccessForSession && session?.id) {
      await prisma.buyerSession.update({
        where: { id: session.id },
        data: { lastDomSuccessAt: new Date() },
      });
    }

    let metaObj: Record<string, unknown> = {};
    try {
      metaObj = JSON.parse(job.meta ?? "{}") as Record<string, unknown>;
    } catch {
      metaObj = {};
    }
    metaObj.parseStats = parseStats;
    metaObj.recoveryStats = {
      browserRetry: parseStats.browserRetry,
      publicFallback: parseStats.publicFallback,
    };
    metaObj.processedProducts = processed;

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "done", finishedAt: new Date(), meta: JSON.stringify(metaObj) },
    });
    logger.info({ jobId: job.id, processed, parseStats }, "monitor job done");
    return { jobId: job.id, processed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(e, "monitor job failed");
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "failed", finishedAt: new Date(), errorMessage: msg.slice(0, 2000) },
    });
    throw e;
  } finally {
    if (ephemeralProfileDir) {
      removeEphemeralWalletProfileDir(ephemeralProfileDir);
    }
  }
}
