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
import { getWbWalletPriceBatch } from "../../walletDom/wbWalletPriceParser.js";
import { resolveBuyerProfileDir } from "../catalogSync/syncCatalog.js";
import { resolveStockLevel, type StockLevel } from "../../lib/stockLevel.js";
import { prepareBuyerSessionForMonitor } from "../buyerSession/buyerSessionManager.js";
import { isBuyerAuthDisabled, isPublicOnlyWalletParse } from "../../lib/repricerMode.js";
import {
  createEphemeralWalletProfileDir,
  removeEphemeralWalletProfileDir,
} from "../../lib/ephemeralWalletProfile.js";
import { resolveObservedBuyerPrices } from "../pricing/resolveObservedBuyerPrices.js";
import {
  aggregateTrustedProductSnapshot,
  buildBuyerRegionalSnapshotFromResolved,
  buildSellerSnapshotFromProduct,
  type BuyerRegionalSnapshot,
} from "../pricing/trustedProductSnapshot.js";

const EVAL_TOL_RUB = 3;

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
    input.parseStatus === "only_regular_found" &&
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

  try {
    let session: Awaited<ReturnType<typeof prisma.buyerSession.findFirst>> = null;
    let profileDir = resolveBuyerProfileDir();
    if (isBuyerAuthDisabled()) {
      ephemeralProfileDir = createEphemeralWalletProfileDir();
      profileDir = ephemeralProfileDir;
      logger.info(
        { tag: "monitor-public-only", profileDir },
        "public parse started — ephemeral browser profile (no buyer auth)",
      );
    } else {
      session = await prisma.buyerSession.findFirst({
        where: { status: "active", isAuthorized: true },
        orderBy: { updatedAt: "desc" },
      });
      profileDir = session?.profileDir ?? resolveBuyerProfileDir();
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

    if (!isBuyerAuthDisabled()) {
      await prepareBuyerSessionForMonitor();
    }

    const parseStats = {
      publicDom: 0,
      popupDom: 0,
      unknown: 0,
      authWall: 0,
      captcha: 0,
      safeModeLastGood: 0,
    };

    const stepsTotal = products.length * destList.length;
    const useWalletBatch = monitorUsesWalletBatch() && stepsTotal > 0;
    const sppViaCookies = monitorSppViaCookies() && !isBuyerAuthDisabled();
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

    async function persistMonitorStep(
      p: ProductRow,
      walletDest: string | null,
      dom: BuyerDomResult,
      pauseAfter: boolean,
    ): Promise<void> {
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
        },
      });
      let buyerWallet = resolved.buyerWallet;
      let showcaseRub = resolved.showcaseRub;
      const buyerRegular = resolved.buyerRegular;

      const parseRecovered =
        dom.success &&
        showcaseRub != null &&
        showcaseRub > 0 &&
        parseStatus !== "parse_failed" &&
        parseStatus !== "auth_required" &&
        parseStatus !== "blocked_or_captcha";

      let usedLastGoodFallback = false;
      if (
        isPublicOnlyWalletParse() &&
        !parseRecovered &&
        p.walletRubLastGood != null &&
        Number.isFinite(p.walletRubLastGood) &&
        p.walletRubLastGood > 0
      ) {
        usedLastGoodFallback = true;
        showcaseRub = Math.round(p.walletRubLastGood);
        buyerWallet = Math.round(p.walletRubLastGood);
        parseStats.safeModeLastGood += 1;
        logger.warn(
          { nmId: p.nmId, tag: "public-parse", rub: showcaseRub },
          "safe mode enabled — last known good wallet value used",
        );
      }

      if (parseRecovered && isPublicOnlyWalletParse()) {
        logger.info({ nmId: p.nmId, tag: "public-parse", parseStatus }, "public dom parsed — wallet/showcase recovered");
      }
      const snapshotWalletSource = resolved.walletSource;
      const buyerRegularSource = resolved.buyerRegularSource;
      const fb = resolved.fallback;
      const { showcaseEff, cookieShowcase, apiWalletRub, domRegular, sppWoWallet } = resolved.signals;
      const priceWithoutWalletRub = resolved.priceWithoutWalletRub;

      const hardAuth =
        parseStatus === "auth_required" || parseStatus === "blocked_or_captcha";
      const hasUsablePrice = resolved.hasUsablePrice || usedLastGoodFallback;

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
        if (resolved.repricingAllowed) {
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
      } else if (stockLevel === "IN_STOCK" && dom.success && !resolved.repricingAllowed) {
        logger.warn(
          {
            tag: "monitor-pricing",
            nmId: p.nmId,
            dest: destKey,
            verificationStatus: resolved.buyerPriceVerification.verificationStatus,
            verificationReason: resolved.buyerPriceVerification.verificationReason,
            verificationMethod: resolved.buyerPriceVerification.verificationMethod,
            trustedSource: resolved.trustedSource,
            repricingAllowed: resolved.repricingAllowed,
            repricingAllowedReason: resolved.repricingAllowedReason,
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
        (parseStatus === "wallet_found" || parseStatus === "only_regular_found");
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
        !resolved.repricingAllowed &&
        evaluationBase === "ok"
          ? "buyer_unverified"
          : evaluationBase;
      if (usedLastGoodFallback) {
        evaluationStatus = "wallet_source_unavailable_safe_hold";
      }

      const sellerBasePriceRub =
        p.sellerPrice != null && Number.isFinite(p.sellerPrice) ? Math.round(p.sellerPrice) : null;
      const detailJson = JSON.stringify({
        parseStatus,
        parseMethod,
        stockLevel,
        evaluationStatus,
        diffSellerVsTarget: diffSeller,
        diffWalletVsTarget: diffWallet,
        buyerRegularSource,
        usedFallback: fb.usedFallback,
        fallbackChain: fb.fallbackChain,
        sellerBasePriceRub,
        repricingAllowed: resolved.repricingAllowed,
        repricingAllowedReason: resolved.repricingAllowedReason,
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
      });

      await prisma.priceSnapshot.create({
        data: {
          productId: p.id,
          nmId: p.nmId,
          sellerPrice: p.sellerPrice,
          buyerRegularPrice: priceWithoutWalletRub,
          buyerWalletPrice: showcaseRub,
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
          parseConfidence: parseConfidence,
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
            lastParseConfidence: parseConfidence,
            lastWalletParseStatus: parseStatus,
            lastEvaluationStatus: evaluationStatus,
            ...(stockLevel === "IN_STOCK" ? { lastSeenInStock: new Date() } : {}),
            ...(parseRecovered && showcaseRub != null && showcaseRub > 0
              ? {
                  lastWalletObservedRub: showcaseRub,
                  lastKnownShowcaseRub: Math.round(showcaseRub),
                  lastKnownWalletRub: Math.round(showcaseRub),
                  lastPriceSeenAt: new Date(),
                  lastPriceSource: buyerRegularSource,
                  walletRubLastGood: Math.round(showcaseRub),
                  walletRubLastGoodAt: new Date(),
                  sourceLastGood: tier ?? "public_dom",
                  parseStatusLastGood: parseStatus ?? null,
                  safeModeHold: false,
                }
              : {}),
            ...(usedLastGoodFallback && showcaseRub != null && showcaseRub > 0
              ? {
                  lastWalletObservedRub: showcaseRub,
                  lastKnownShowcaseRub: Math.round(showcaseRub),
                  lastKnownWalletRub: Math.round(showcaseRub),
                  lastPriceSeenAt: new Date(),
                  lastPriceSource: "last_good",
                  safeModeHold: true,
                }
              : {}),
            ...(priceWithoutWalletRub != null && priceWithoutWalletRub > 0
              ? { lastRegularObservedRub: priceWithoutWalletRub }
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
      const raw = await getWbWalletPriceBatch(
        {
          userDataDir: profileDir,
          headless: true,
          browser: resolveWalletDomBrowserKind(),
        },
        planned.map((x) => ({
          nmId: x.p.nmId,
          region: x.walletDest,
          cabinetStock: x.p.stock,
        })),
        {
          interStepDelayMs: env.REPRICER_MONITOR_BATCH_INTER_STEP_MS,
          fetchShowcaseWithCookies: isBuyerAuthDisabled() ? false : sppViaCookies,
          cardDetailFallbackDest: env.REPRICER_WALLET_DEST.trim() || null,
          maxCardApiAttempts: env.REPRICER_MONITOR_CARD_API_MAX_ATTEMPTS,
        },
      );
      for (let i = 0; i < planned.length; i += 1) {
        const row = planned[i]!;
        const dom = walletParserResultToBuyerDom(raw[i]!);
        await persistMonitorStep(row.p, row.walletDest, dom, false);
      }
    } else {
      for (const row of planned) {
        const dom = await getBuyerDisplayedPrice({
          nmId: row.p.nmId,
          profileDir,
          regionDest: row.walletDest,
          timeoutMs: env.REPRICER_MONITOR_WALLET_TIMEOUT_MS,
          fetchShowcaseWithCookies:
            isBuyerAuthDisabled() ? false : sppViaCookies || Boolean(row.walletDest?.trim()),
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
                lastKnownWalletRub: trusted.aggregatedShowcaseWithWalletRub,
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
