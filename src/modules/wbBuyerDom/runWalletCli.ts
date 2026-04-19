import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { resolveWbBrowserHeadless } from "../../lib/wbBrowserEnv.js";
import { logger } from "../../lib/logger.js";
import { runtimePaths } from "../../lib/runtimePaths.js";
import type {
  BrowserKind,
  WalletEvidenceKind,
  WalletParserResult,
  WalletParseStatus,
} from "../../walletDom/wbWalletPriceParser.js";
import type { BuyerPriceVerificationSnapshot } from "../pricing/buyerPriceVerification.js";

const MAC_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_CANARY =
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
const MAC_CHROME_BETA =
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";

export type BuyerDomResult = {
  nmId: number | null;
  url: string;
  region: string | null;
  priceRegular: number | null;
  /** Основная витринная цена на карточке (первая для покупателя). */
  showcaseRub?: number | null;
  /** Подтверждённая цена WB Кошелька — только если есть доказательство в парсере. */
  walletRub?: number | null;
  /** Цена без кошелька, с СПП (cookies / orchestrator). */
  nonWalletRub?: number | null;
  walletConfirmed?: boolean | null;
  walletEvidence?: WalletEvidenceKind | null;
  priceDiscounted: number | null;
  priceWallet: number | null;
  walletLabel: string | null;
  walletDiscountText: string | null;
  parsedAt: string;
  source: "dom";
  success: boolean;
  error?: string | null;
  parseStatus?: string | null;
  sourceConfidence?: number | null;
  parseMethod?: string | null;
  /**
   * Итоговая витринная цена из secondary/reference источников.
   */
  showcaseRubFromCookies?: number | null;
  showcaseRubEffective?: number | null;
  showcaseResolvedSource?: "product_page_dom" | "card_api" | "none";
  showcaseApiRub?: number | null;
  apiWalletRub?: number | null;
  showcaseResolutionNote?: string | null;
  /** Старая цена на витрине (productLinePriceOld). */
  oldPriceRub?: number | null;
  /** Эвристика DOM («нет в наличии» и т.п.); вместе с остатком кабинета — для OUT_OF_STOCK. */
  inStock?: boolean | null;
  /** URL вкладки после парсинга (сверка query `dest`). */
  browserUrlAfterParse?: string | null;
  /** `dest` в card.wb.ru на шаге мониторинга. */
  showcaseQueryDest?: string | null;
  showcaseRubFromCardApi?: number | null;
  showcaseRubFromDom?: number | null;
  showcasePriceRub?: number | null;
  priceWithSppWithoutWalletRub?: number | null;
  verificationMethod?: "dom_wallet" | "unverified" | null;
  verificationStatus?: "VERIFIED" | "UNVERIFIED" | null;
  verificationReason?: string | null;
  verificationSource?: "dom_buybox" | "product_page_wallet_selector" | "card_api" | "none" | null;
  sourcePriority?: string | null;
  sourceConflictDetected?: boolean | null;
  sourceConflictDeltaRub?: number | null;
  conflictAcceptedSource?: "local_verified" | "card_api" | "none" | null;
  buyerPriceVerification?: BuyerPriceVerificationSnapshot | null;

  destApplied?: boolean | null;
  regionConfirmed?: boolean | null;
  destAppliedButNotConfirmed?: boolean | null;
  locationMarker?: string | null;
  priceBlockSignature?: string | null;
  popupOpened?: boolean | null;
  popupWalletRub?: number | null;
  popupWithoutWalletRub?: number | null;
  regionPriceAmbiguous?: boolean | null;
  regionDomConfirmed?: boolean | null;
  regionConfirmedByRequest?: boolean | null;
  regionConfirmedByStableReload?: boolean | null;
  walletPriceFirstRead?: number | null;
  walletPriceSecondRead?: number | null;
  finalRegionConfidence?: "HIGH" | "MEDIUM" | "LOW" | null;
  finalWalletConfidence?: "HIGH" | "MEDIUM" | "LOW" | null;
  repricingDecisionSource?: string | null;
  /** Слой стратегии парсинга (batch wallet DOM). */
  priceParseSource?: string | null;
};

function isWalletParseStatus(s: string): s is WalletParseStatus {
  return (
    s === "loaded_wallet_confirmed" ||
    s === "loaded_showcase_only" ||
    s === "loaded_no_price" ||
    s === "parse_failed" ||
    s === "auth_required" ||
    s === "blocked_or_captcha"
  );
}

/** Парсит stdout wallet CLI (в т.ч. многострочный JSON.stringify(..., null, 2)). */
function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
  const raw = stdout.trim();
  const first = raw.indexOf("{");
  if (first < 0) return null;
  let depth = 0;
  for (let i = first; i < raw.length; i += 1) {
    const c = raw[i]!;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(first, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseBuyerPriceVerificationFromJson(
  raw: unknown,
): BuyerPriceVerificationSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (o.verificationStatus !== "VERIFIED" && o.verificationStatus !== "UNVERIFIED") return undefined;
  const num = (k: string): number | null => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const bool = (k: string): boolean => o[k] === true;
  return {
    verificationStatus: o.verificationStatus as BuyerPriceVerificationSnapshot["verificationStatus"],
    verificationReason: typeof o.verificationReason === "string" ? o.verificationReason : "",
    sellerBasePriceRub: num("sellerBasePriceRub"),
    showcaseWalletPrice: num("showcaseWalletPrice"),
    walletPriceVerified: num("walletPriceVerified"),
    priceWithoutWallet: num("priceWithoutWallet"),
    walletDiscountRub: num("walletDiscountRub"),
    walletDiscount: num("walletDiscount") ?? num("walletDiscountRub"),
    walletIconDetected: bool("walletIconDetected"),
    sourceSeller: o.sourceSeller === "wb_seller_api" ? "wb_seller_api" : "none",
    sourceWalletVisible: o.sourceWalletVisible === "dom_price_block" ? "dom_price_block" : "none",
    sourceWalletDetails:
      o.sourceWalletDetails === "product_page_wallet_selector"
        ? "product_page_wallet_selector"
        : "none",
    sourceWithoutWallet:
      o.sourceWithoutWallet === "formula"
        ? "formula"
        : o.sourceWithoutWallet === "card_api_pair"
          ? "card_api_pair"
          : "none",
    verificationMethod:
      o.verificationMethod === "dom_wallet" || o.verificationMethod === "unverified"
        ? o.verificationMethod
        : "unverified",
    repricingAllowed: o.repricingAllowed === true,
    trustedSource: o.trustedSource === "product_page_wallet_selector" ? "product_page_wallet_selector" : "none",
    cardApiShowcaseRub: num("cardApiShowcaseRub"),
    cardApiWalletRub: num("cardApiWalletRub"),
  };
}

function walletResultFromCliJson(
  j: Record<string, unknown>,
  defaults: { nmId: number; region: string | null },
): WalletParserResult {
  const psRaw = typeof j.parseStatus === "string" ? j.parseStatus : "";
  const parseStatus: WalletParseStatus = isWalletParseStatus(psRaw) ? psRaw : "parse_failed";
  const src = j.showcaseResolvedSource;
  const showcaseResolvedSource =
    src === "product_page_dom" || src === "card_api" || src === "none" ? src : undefined;

  const wEv = j.walletEvidence;
  const walletEvidence: WalletEvidenceKind | undefined =
    wEv === "buyer_session" ||
    wEv === "wallet_label" ||
    wEv === "wallet_marker" ||
    wEv === "showcase_less_than_nonwallet" ||
    wEv === "dom_wallet"
      ? wEv
      : undefined;

  return {
    nmId: typeof j.nmId === "number" ? j.nmId : defaults.nmId,
    url:
      typeof j.url === "string"
        ? j.url
        : `https://www.wildberries.ru/catalog/${defaults.nmId}/detail.aspx`,
    region: typeof j.region === "string" ? j.region : defaults.region,
    priceRegular: typeof j.priceRegular === "number" ? j.priceRegular : null,
    showcaseRub: typeof j.showcaseRub === "number" ? j.showcaseRub : undefined,
    walletRub: typeof j.walletRub === "number" ? j.walletRub : undefined,
    nonWalletRub: typeof j.nonWalletRub === "number" ? j.nonWalletRub : undefined,
    walletConfirmed: j.walletConfirmed === true ? true : j.walletConfirmed === false ? false : undefined,
    walletEvidence,
    discountedPrice: typeof j.discountedPrice === "number" ? j.discountedPrice : null,
    priceWallet: typeof j.priceWallet === "number" ? j.priceWallet : null,
    walletLabel: typeof j.walletLabel === "string" ? j.walletLabel : null,
    walletDiscountText: typeof j.walletDiscountText === "string" ? j.walletDiscountText : null,
    inStock: typeof j.inStock === "boolean" ? j.inStock : null,
    parsedAt: typeof j.parsedAt === "string" ? j.parsedAt : new Date().toISOString(),
    source: "dom",
    parseStatus,
    sourceConfidence: typeof j.sourceConfidence === "number" ? j.sourceConfidence : 0,
    parseMethod: typeof j.parseMethod === "string" ? j.parseMethod : "cli",
    showcaseRubEffective: typeof j.showcaseRubEffective === "number" ? j.showcaseRubEffective : null,
    showcaseResolvedSource,
    showcaseApiRub: typeof j.showcaseApiRub === "number" ? j.showcaseApiRub : null,
    apiWalletRub: typeof j.apiWalletRub === "number" ? j.apiWalletRub : null,
    showcaseResolutionNote: typeof j.showcaseResolutionNote === "string" ? j.showcaseResolutionNote : null,
    showcaseRubFromCookies: typeof j.showcaseRubFromCookies === "number" ? j.showcaseRubFromCookies : null,
    cardApiShowcaseRub: typeof j.cardApiShowcaseRub === "number" ? j.cardApiShowcaseRub : undefined,
    cardApiWalletRub: typeof j.cardApiWalletRub === "number" ? j.cardApiWalletRub : undefined,
    showcaseRubFromCardApi:
      typeof j.showcaseRubFromCardApi === "number" ? j.showcaseRubFromCardApi : undefined,
    showcaseRubFromDom: typeof j.showcaseRubFromDom === "number" ? j.showcaseRubFromDom : undefined,
    showcasePriceRub: typeof j.showcasePriceRub === "number" ? j.showcasePriceRub : undefined,
    priceWithSppWithoutWalletRub:
      typeof j.priceWithSppWithoutWalletRub === "number" ? j.priceWithSppWithoutWalletRub : undefined,
    verificationMethod:
      j.verificationMethod === "dom_wallet" || j.verificationMethod === "unverified"
        ? j.verificationMethod
        : undefined,
    verificationStatus:
      j.verificationStatus === "VERIFIED" || j.verificationStatus === "UNVERIFIED"
        ? j.verificationStatus
        : undefined,
    verificationReason:
      typeof j.verificationReason === "string" ? j.verificationReason : undefined,
    verificationSource:
      j.verificationSource === "dom_buybox" ||
      j.verificationSource === "product_page_wallet_selector" ||
      j.verificationSource === "card_api" ||
      j.verificationSource === "none"
        ? j.verificationSource
        : undefined,
    sourcePriority: typeof j.sourcePriority === "string" ? j.sourcePriority : undefined,
    sourceConflictDetected:
      typeof j.sourceConflictDetected === "boolean" ? j.sourceConflictDetected : undefined,
    sourceConflictDeltaRub:
      typeof j.sourceConflictDeltaRub === "number" ? j.sourceConflictDeltaRub : undefined,
    conflictAcceptedSource:
      j.conflictAcceptedSource === "local_verified" ||
      j.conflictAcceptedSource === "card_api" ||
      j.conflictAcceptedSource === "none"
        ? j.conflictAcceptedSource
        : undefined,
    buyerPriceVerification: parseBuyerPriceVerificationFromJson(j.buyerPriceVerification),

    destApplied: typeof j.destApplied === "boolean" ? j.destApplied : undefined,
    regionConfirmed: typeof j.regionConfirmed === "boolean" ? j.regionConfirmed : undefined,
    destAppliedButNotConfirmed:
      typeof j.destAppliedButNotConfirmed === "boolean" ? j.destAppliedButNotConfirmed : undefined,
    locationMarker: typeof j.locationMarker === "string" ? j.locationMarker : undefined,
    priceBlockSignature: typeof j.priceBlockSignature === "string" ? j.priceBlockSignature : undefined,
    popupOpened: typeof j.popupOpened === "boolean" ? j.popupOpened : undefined,
    popupWalletRub: typeof j.popupWalletRub === "number" ? j.popupWalletRub : undefined,
    popupWithoutWalletRub:
      typeof j.popupWithoutWalletRub === "number" ? j.popupWithoutWalletRub : undefined,
    regionPriceAmbiguous:
      typeof j.regionPriceAmbiguous === "boolean" ? j.regionPriceAmbiguous : undefined,
    regionDomConfirmed:
      typeof j.regionDomConfirmed === "boolean" ? j.regionDomConfirmed : undefined,
    regionConfirmedByRequest:
      typeof j.regionConfirmedByRequest === "boolean" ? j.regionConfirmedByRequest : undefined,
    regionConfirmedByStableReload:
      typeof j.regionConfirmedByStableReload === "boolean" ? j.regionConfirmedByStableReload : undefined,
    walletPriceFirstRead:
      typeof j.walletPriceFirstRead === "number" ? j.walletPriceFirstRead : undefined,
    walletPriceSecondRead:
      typeof j.walletPriceSecondRead === "number" ? j.walletPriceSecondRead : undefined,
    finalRegionConfidence:
      j.finalRegionConfidence === "HIGH" ||
      j.finalRegionConfidence === "MEDIUM" ||
      j.finalRegionConfidence === "LOW"
        ? j.finalRegionConfidence
        : undefined,
    finalWalletConfidence:
      j.finalWalletConfidence === "HIGH" ||
      j.finalWalletConfidence === "MEDIUM" ||
      j.finalWalletConfidence === "LOW"
        ? j.finalWalletConfidence
        : undefined,
    repricingDecisionSource:
      typeof j.repricingDecisionSource === "string" ? j.repricingDecisionSource : undefined,
  };
}

/** Тот же выбор chrome/chromium, что и для CLI (`--browser=…`). */
export function resolveWalletDomBrowserKind(): BrowserKind {
  if (env.BROWSER_EXECUTABLE_PATH.trim()) return "chrome";
  const override = process.env.REPRICER_DOM_BROWSER?.trim().toLowerCase();
  if (override === "chrome") return "chrome";
  if (override === "chromium") return "chromium";
  if (process.platform === "darwin") {
    if (fs.existsSync(MAC_CHROME) || fs.existsSync(MAC_CANARY) || fs.existsSync(MAC_CHROME_BETA)) {
      return "chrome";
    }
  }
  return "chromium";
}

function domBrowserCliFlag(): string {
  const k = resolveWalletDomBrowserKind();
  return k === "chrome" ? "--browser=chrome" : "--browser=chromium";
}

function headlessCliFlag(): string {
  const headless = resolveWbBrowserHeadless();
  return `--headless=${headless ? "true" : "false"}`;
}

export function walletParserResultToBuyerDom(r: WalletParserResult): BuyerDomResult {
  const hardFail =
    r.parseStatus === "parse_failed" ||
    r.parseStatus === "auth_required" ||
    r.parseStatus === "blocked_or_captcha";
  return {
    nmId: r.nmId,
    url: r.url,
    region: r.region,
    priceRegular: r.priceRegular,
    showcaseRub: r.showcaseRub ?? r.showcaseRubEffective ?? null,
    walletRub: r.walletRub ?? null,
    nonWalletRub: r.nonWalletRub ?? r.priceWithSppWithoutWalletRub ?? null,
    walletConfirmed: typeof r.walletConfirmed === "boolean" ? r.walletConfirmed : null,
    walletEvidence: r.walletEvidence ?? null,
    priceDiscounted: r.discountedPrice,
    priceWallet: r.priceWallet,
    walletLabel: r.walletLabel,
    walletDiscountText: r.walletDiscountText,
    parsedAt: r.parsedAt,
    source: "dom",
    success: !hardFail,
    error: hardFail ? `DOM: ${r.parseStatus ?? "unknown"}` : null,
    parseStatus: r.parseStatus,
    sourceConfidence: r.sourceConfidence,
    parseMethod: r.parseMethod,
    showcaseRubFromCookies: r.showcaseRubFromCookies ?? null,
    showcaseRubEffective: r.showcaseRubEffective ?? null,
    showcaseResolvedSource: r.showcaseResolvedSource,
    showcaseApiRub: r.showcaseApiRub ?? null,
    apiWalletRub: r.apiWalletRub ?? null,
    showcaseResolutionNote: r.showcaseResolutionNote ?? null,
    oldPriceRub: (r as any).oldPriceRub ?? null,
    inStock: r.inStock ?? null,
    browserUrlAfterParse: r.browserUrlAfterParse ?? null,
    showcaseQueryDest: r.showcaseQueryDest ?? null,
    showcaseRubFromCardApi: r.showcaseRubFromCardApi ?? null,
    showcaseRubFromDom: r.showcaseRubFromDom ?? null,
    showcasePriceRub: r.showcasePriceRub ?? null,
    priceWithSppWithoutWalletRub: r.priceWithSppWithoutWalletRub ?? null,
    verificationMethod:
      r.verificationMethod === "dom_wallet" || r.verificationMethod === "unverified"
        ? r.verificationMethod
        : null,
    verificationStatus: r.verificationStatus ?? null,
    verificationReason: r.verificationReason ?? null,
    verificationSource:
      r.verificationSource === "dom_buybox" ||
      r.verificationSource === "product_page_wallet_selector" ||
      r.verificationSource === "card_api" ||
      r.verificationSource === "none"
        ? r.verificationSource
        : null,
    sourcePriority: r.sourcePriority ?? null,
    sourceConflictDetected: r.sourceConflictDetected ?? null,
    sourceConflictDeltaRub: r.sourceConflictDeltaRub ?? null,
    conflictAcceptedSource: r.conflictAcceptedSource ?? null,
    buyerPriceVerification: r.buyerPriceVerification ?? null,

    destApplied: typeof r.destApplied === "boolean" ? r.destApplied : null,
    regionConfirmed: typeof r.regionConfirmed === "boolean" ? r.regionConfirmed : null,
    destAppliedButNotConfirmed:
      typeof r.destAppliedButNotConfirmed === "boolean" ? r.destAppliedButNotConfirmed : null,
    locationMarker: typeof r.locationMarker === "string" ? r.locationMarker : null,
    priceBlockSignature: typeof r.priceBlockSignature === "string" ? r.priceBlockSignature : null,
    popupOpened: typeof r.popupOpened === "boolean" ? r.popupOpened : null,
    popupWalletRub: typeof r.popupWalletRub === "number" ? r.popupWalletRub : null,
    popupWithoutWalletRub: typeof r.popupWithoutWalletRub === "number" ? r.popupWithoutWalletRub : null,
    regionPriceAmbiguous:
      typeof r.regionPriceAmbiguous === "boolean" ? r.regionPriceAmbiguous : null,
    regionDomConfirmed:
      typeof r.regionDomConfirmed === "boolean" ? r.regionDomConfirmed : null,
    regionConfirmedByRequest:
      typeof r.regionConfirmedByRequest === "boolean" ? r.regionConfirmedByRequest : null,
    regionConfirmedByStableReload:
      typeof r.regionConfirmedByStableReload === "boolean" ? r.regionConfirmedByStableReload : null,
    walletPriceFirstRead:
      typeof r.walletPriceFirstRead === "number" ? r.walletPriceFirstRead : null,
    walletPriceSecondRead:
      typeof r.walletPriceSecondRead === "number" ? r.walletPriceSecondRead : null,
    finalRegionConfidence:
      r.finalRegionConfidence === "HIGH" ||
      r.finalRegionConfidence === "MEDIUM" ||
      r.finalRegionConfidence === "LOW"
        ? r.finalRegionConfidence
        : null,
    finalWalletConfidence:
      r.finalWalletConfidence === "HIGH" ||
      r.finalWalletConfidence === "MEDIUM" ||
      r.finalWalletConfidence === "LOW"
        ? r.finalWalletConfidence
        : null,
    priceParseSource: r.priceParseSource ?? null,
    repricingDecisionSource:
      typeof r.repricingDecisionSource === "string" ? r.repricingDecisionSource : null,
  };
}

/**
 * Playwright wallet CLI (собранный в этом репозитории: dist/walletDom/cli.js).
 * REPRICER_WALLET_CLI_PATH — относительно cwd сервера или абсолютный путь.
 */
export async function getBuyerDisplayedPrice(opts: {
  nmId: number;
  profileDir: string;
  /** dest из справочника регионов WB (витрина: цена/СПП зависят от региона) */
  regionDest?: string | null;
  timeoutMs?: number;
  /** card.wb.ru / showcase после DOM (не зависит от wallet batch). */
  fetchShowcaseWithCookies?: boolean;
}): Promise<BuyerDomResult> {
  const cliPath = path.isAbsolute(env.REPRICER_WALLET_CLI_PATH)
    ? env.REPRICER_WALLET_CLI_PATH
    : path.resolve(runtimePaths.projectRoot, env.REPRICER_WALLET_CLI_PATH);
  const cwd = path.isAbsolute(env.REPRICER_WALLET_PROJECT_ROOT)
    ? env.REPRICER_WALLET_PROJECT_ROOT
    : runtimePaths.projectRoot;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const dest = opts.regionDest?.trim() ?? null;

  const args = [
    cliPath,
    `--nmId=${opts.nmId}`,
    `--userDataDir=${opts.profileDir}`,
    headlessCliFlag(),
    domBrowserCliFlag(),
  ];
  if (dest) {
    args.push(`--region=${dest}`);
  }
  if (opts.fetchShowcaseWithCookies === true) {
    args.push("--showcaseCookies=true");
  }

  if (!fs.existsSync(cliPath)) {
    logger.error({ cliPath }, "wallet CLI not found — run: npm install && npm run build && npx playwright install chromium");
    return {
      nmId: opts.nmId,
      url: `https://www.wildberries.ru/catalog/${opts.nmId}/detail.aspx`,
      region: dest,
      priceRegular: null,
      priceDiscounted: null,
      priceWallet: null,
      walletLabel: null,
      walletDiscountText: null,
      parsedAt: new Date().toISOString(),
      source: "dom",
      success: false,
      error: `CLI missing: ${cliPath}`,
      parseStatus: "parse_failed",
      sourceConfidence: 0,
    };
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, WB_WALLET_DOM_SYNC: "1", BROWSER_EXECUTABLE_PATH: env.BROWSER_EXECUTABLE_PATH },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        nmId: opts.nmId,
        url: `https://www.wildberries.ru/catalog/${opts.nmId}/detail.aspx`,
        region: dest,
        priceRegular: null,
        priceDiscounted: null,
        priceWallet: null,
        walletLabel: null,
        walletDiscountText: null,
        parsedAt: new Date().toISOString(),
        source: "dom",
        success: false,
        error: `timeout ${timeoutMs}ms`,
        parseStatus: "parse_failed",
        sourceConfidence: 0,
      });
    }, timeoutMs);

    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      logger.warn({ err, nmId: opts.nmId }, "wallet CLI spawn error");
      resolve({
        nmId: opts.nmId,
        url: `https://www.wildberries.ru/catalog/${opts.nmId}/detail.aspx`,
        region: dest,
        priceRegular: null,
        priceDiscounted: null,
        priceWallet: null,
        walletLabel: null,
        walletDiscountText: null,
        parsedAt: new Date().toISOString(),
        source: "dom",
        success: false,
        error: String(err),
        parseStatus: "parse_failed",
        sourceConfidence: 0,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(0, 500), nmId: opts.nmId }, "wallet CLI failed");
        resolve({
          nmId: opts.nmId,
          url: `https://www.wildberries.ru/catalog/${opts.nmId}/detail.aspx`,
          region: dest,
          priceRegular: null,
          priceDiscounted: null,
          priceWallet: null,
          walletLabel: null,
          walletDiscountText: null,
          parsedAt: new Date().toISOString(),
          source: "dom",
          success: false,
          error: stderr.slice(0, 2000) || `exit ${code}`,
          parseStatus: "parse_failed",
          sourceConfidence: 0,
        });
        return;
      }
      try {
        const j = parseLastJsonObject(stdout);
        if (!j) throw new Error("no JSON in stdout");
        const wpr = walletResultFromCliJson(j, { nmId: opts.nmId, region: dest });
        resolve(walletParserResultToBuyerDom(wpr));
      } catch (e) {
        resolve({
          nmId: opts.nmId,
          url: `https://www.wildberries.ru/catalog/${opts.nmId}/detail.aspx`,
          region: dest,
          priceRegular: null,
          priceDiscounted: null,
          priceWallet: null,
          walletLabel: null,
          walletDiscountText: null,
          parsedAt: new Date().toISOString(),
          source: "dom",
          success: false,
          error: String(e),
          parseStatus: "parse_failed",
          sourceConfidence: 0,
        });
      }
    });
  });
}
