import type { MinPriceRule, PriceSnapshot, WbProduct } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import {
  buildBuyerSideFromPriceSnapshot,
  buildBuyerSideFromWbProductFallbackChain,
  buildSellerSideFromWbProduct,
  buildUnifiedObservation,
  destStringToNumber,
  type BuyerSidePricesJson,
  type SellerSidePricesJson,
  type UnifiedPriceObservationJson,
  toUnifiedRub,
} from "./unifiedPriceModel.js";
import { prisma } from "./prisma.js";
import { computeRepricingSummary } from "./repricingSummary.js";
import { regionLabelForDest } from "./wbRegions.js";

export type RegionPriceRow = {
  dest: string;
  label: string;
  /** Витрина WB (верхняя цена карточки = с WB Кошельком). */
  walletPriceRub: number | null;
  /** Цена без WB Кошелька. */
  regularPriceRub: number | null;
  /** СПП в %: (sppRub / sellerDiscountPriceRub) * 100. */
  sppPercent: number | null;
  walletDiscountRub: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  source: string | null;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | null;
  confidenceLevel: "HIGH" | "MEDIUM" | "LOW" | null;
  priceParseMode: "dom_wallet_only" | "fallback" | "unverified" | null;
};

export type PrimaryRegionPrices = {
  dest: string;
  label: string;
  walletPriceRub: number | null;
  regularPriceRub: number | null;
  sppPercent: number | null;
  walletDiscountRub: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  priceParseMode: "dom_wallet_only" | "fallback" | "unverified" | null;
};

/**
 * Пара цифр для сводных колонок каталога: всегда из одного региона (иначе min(кош) и min(СПП) — разные склады → «СПП ниже кошелька»).
 */
export type CatalogPriceHeadline = {
  dest: string;
  label: string;
  walletPriceRub: number | null;
  regularPriceRub: number | null;
  sppPercent: number | null;
  walletDiscountRub: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  priceParseMode: "dom_wallet_only" | "fallback" | "unverified" | null;
};

function enforceWalletNotAboveSpp(
  wallet: number | null,
  regular: number | null,
): { wallet: number | null; regular: number | null } {
  if (
    wallet != null &&
    regular != null &&
    wallet > 0 &&
    regular > 0 &&
    regular < wallet
  ) {
    /** Никогда не переставляем местами: WB должен оставаться WB, конфликтную СПП скрываем. */
    return { wallet, regular: null };
  }
  return { wallet, regular };
}

function normalizeWalletVsRegularBySource(
  snapshot: PriceSnapshot,
  wallet: number | null,
  regular: number | null,
): { wallet: number | null; regular: number | null } {
  // Новая модель WB: витрина = цена с кошельком.
  // Не переносим значения между колонками на основании legacy-source.
  void snapshot;
  return { wallet, regular };
}

type SnapshotPriceMeta = {
  oldPriceRub: number | null;
  sppPercent: number | null;
  walletDiscountRub: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  priceParseMode: "dom_wallet_only" | "fallback" | "unverified" | null;
};

type BuyerVerificationMeta = {
  verificationStatus: "VERIFIED" | "UNVERIFIED" | null;
  verificationReason: string | null;
  repricingAllowed: boolean | null;
  verificationSource:
    | "dom_buybox"
    | "product_page_wallet_selector"
    | "card_api"
    | "none"
    | "unverified"
    | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  repricingAllowedReason: string | null;
  blockedBySafetyRule: string[] | null;
};

function buyerVerificationMeta(snapshot: PriceSnapshot | null | undefined): BuyerVerificationMeta {
  if (!snapshot?.detailJson) {
    return {
      verificationStatus: null,
      verificationReason: null,
      repricingAllowed: null,
      verificationSource: null,
      confidence: null,
      repricingAllowedReason: null,
      blockedBySafetyRule: null,
    };
  }
  let dj: Record<string, unknown> = {};
  try {
    dj = JSON.parse(snapshot.detailJson) as Record<string, unknown>;
  } catch {
    return {
      verificationStatus: null,
      verificationReason: null,
      repricingAllowed: null,
      verificationSource: null,
      confidence: null,
      repricingAllowedReason: null,
      blockedBySafetyRule: null,
    };
  }
  const raw = dj.buyerPriceVerification;
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const verificationStatus =
    (v?.verificationStatus === "VERIFIED" || v?.verificationStatus === "UNVERIFIED"
      ? v.verificationStatus
      : null) ??
    (dj.regionalVerificationStatus === "VERIFIED" || dj.regionalVerificationStatus === "UNVERIFIED"
      ? dj.regionalVerificationStatus
      : null);
  const verificationReason =
    (typeof v?.verificationReason === "string" && v.verificationReason.trim().length > 0
      ? v.verificationReason
      : null) ??
    (verificationStatus === "VERIFIED" ? "formula_model_ok" : null);
  const repricingAllowed =
    (typeof v?.repricingAllowed === "boolean" ? v.repricingAllowed : null) ??
    (typeof dj.repricingAllowed === "boolean" ? dj.repricingAllowed : null);
  const verificationSource =
    dj.verificationSource === "dom_buybox" ||
    dj.verificationSource === "product_page_wallet_selector" ||
    dj.verificationSource === "card_api" ||
    dj.verificationSource === "none" ||
    dj.verificationSource === "unverified"
      ? dj.verificationSource
      : null;
  const confidence =
    dj.confidence === "HIGH" || dj.confidence === "MEDIUM" || dj.confidence === "LOW"
      ? dj.confidence
      : null;
  const repricingAllowedReason =
    typeof dj.repricingAllowedReason === "string" && dj.repricingAllowedReason.trim().length > 0
      ? dj.repricingAllowedReason
      : null;
  const blockedBySafetyRule = Array.isArray(dj.blockedBySafetyRule)
    ? dj.blockedBySafetyRule.filter((x): x is string => typeof x === "string")
    : null;
  return {
    verificationStatus,
    verificationReason,
    repricingAllowed,
    verificationSource,
    confidence,
    repricingAllowedReason,
    blockedBySafetyRule,
  };
}

function snapshotPriceMeta(snapshot: PriceSnapshot, walletRub: number | null, regularRub: number | null): SnapshotPriceMeta {
  let dj: Record<string, unknown> = {};
  try {
    dj = snapshot.detailJson ? (JSON.parse(snapshot.detailJson) as Record<string, unknown>) : {};
  } catch {
    dj = {};
  }
  const explicitSpp = typeof dj.sppPercent === "number" && Number.isFinite(dj.sppPercent) ? dj.sppPercent : null;
  const sppRub =
    typeof dj.sppRub === "number" && Number.isFinite(dj.sppRub) && dj.sppRub >= 0
      ? Math.round(dj.sppRub)
      : null;
  const sellerDiscountPriceRub =
    typeof dj.sellerDiscountPriceRub === "number" &&
    Number.isFinite(dj.sellerDiscountPriceRub) &&
    dj.sellerDiscountPriceRub > 0
      ? Math.round(dj.sellerDiscountPriceRub)
      : null;
  const calcSpp =
    sellerDiscountPriceRub != null &&
    sppRub != null &&
    sellerDiscountPriceRub > 0 &&
    sppRub <= sellerDiscountPriceRub
      ? Math.round(((sppRub / sellerDiscountPriceRub) * 100) * 10) / 10
      : null;
  const walletDiscountRub =
    walletRub != null && regularRub != null ? Math.max(0, Math.round(regularRub - walletRub)) : null;
  const srcConfRaw = dj.sourceConfidence;
  const sourceConfidence =
    srcConfRaw === "high" || srcConfRaw === "medium" || srcConfRaw === "low" ? srcConfRaw : null;
  const parseModeRaw = dj.priceParseMode;
  const priceParseMode =
    parseModeRaw === "dom_wallet_only" ||
    parseModeRaw === "fallback" ||
    parseModeRaw === "unverified"
      ? parseModeRaw
      : null;
  return {
    oldPriceRub: null,
    sppPercent: explicitSpp ?? calcSpp,
    walletDiscountRub,
    sourceConfidence,
    priceParseMode,
  };
}

function snapshotSource(snapshot: PriceSnapshot): string | null {
  let dj: Record<string, unknown> = {};
  try {
    dj = snapshot.detailJson ? (JSON.parse(snapshot.detailJson) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  if (typeof dj.trustedSource === "string" && dj.trustedSource.trim().length > 0) {
    return dj.trustedSource.trim();
  }
  if (typeof dj.verificationSource === "string" && dj.verificationSource.trim().length > 0) {
    return dj.verificationSource.trim();
  }
  return null;
}

function buildCatalogPriceHeadline(
  br: RegionPriceRow[],
  discBase: number | null,
): CatalogPriceHeadline | null {
  void discBase;
  if (br.length === 0) return null;
  const trustedRows = br.filter(
    (r) =>
      r.verificationStatus === "VERIFIED" &&
      (r.confidenceLevel === "HIGH" || r.confidenceLevel === "MEDIUM"),
  );
  const withWallet = trustedRows.filter((r) => r.walletPriceRub != null && r.walletPriceRub > 0);
  if (withWallet.length > 0) {
    const row = withWallet.reduce((a, b) =>
      (a.walletPriceRub as number) <= (b.walletPriceRub as number) ? a : b,
    );
    const w = row.walletPriceRub;
    let reg = row.regularPriceRub;
    if (w != null && reg != null && reg < w) {
      reg = null;
    }
    const walletDiscountRub =
      w != null && reg != null && reg > w ? Math.round(reg - w) : row.walletDiscountRub ?? null;
    return {
      dest: row.dest,
      label: row.label,
      walletPriceRub: w,
      regularPriceRub: reg,
      sppPercent: row.sppPercent ?? null,
      walletDiscountRub,
      sourceConfidence: row.sourceConfidence ?? null,
      priceParseMode: row.priceParseMode ?? null,
    };
  }
  const withReg = trustedRows.filter((r) => r.regularPriceRub != null && r.regularPriceRub > 0);
  if (withReg.length === 0) return null;
  const row = withReg.reduce((a, b) =>
    (a.regularPriceRub as number) <= (b.regularPriceRub as number) ? a : b,
  );
  return {
    dest: row.dest,
    label: row.label,
    walletPriceRub: row.walletPriceRub,
    regularPriceRub: row.regularPriceRub,
    sppPercent: row.sppPercent ?? null,
    walletDiscountRub: row.walletDiscountRub ?? null,
    sourceConfidence: row.sourceConfidence ?? null,
    priceParseMode: row.priceParseMode ?? null,
  };
}

export type ProductTableRow = WbProduct & {
  minPriceRule: MinPriceRule | null;
  /** Минимально допустимая / фиксированная цель (правило или последняя фикс. цена) */
  fixedOrMinRub: number | null;
  /**
   * Legacy: минимальный verified wallet среди регионов (агрегат для совместимости).
   * Для отображения используйте `buyer` / `unified.buyer` / плоские walletRub.
   */
  showcaseFinalRub: number | null;
  /** Сводный СПП % (к той же базе «со скидкой»), по минимальному итогу */
  sppPercentFromDiscounted: number | null;
  /** По каждому региону */
  regionBreakdown: RegionPriceRow[];
  /** Первый выбранный регион или первый регион со снимком — для колонок таблицы */
  primaryRegion: PrimaryRegionPrices | null;
  /** Сводные колонки «кош / СПП / %» из одного региона (мин. кошелёк среди регионов со снимком) */
  catalogPriceHeadline: CatalogPriceHeadline | null;
  /** Короткая подсказка для UI (OOS / нет витрины при сохранённом минимуме) */
  pricingStatusHint: string | null;
  /** Верификация buyer-facing цен по основному региону (из detailJson). */
  buyerVerificationStatus: "VERIFIED" | "UNVERIFIED" | null;
  buyerVerificationReason: string | null;
  repricingAllowed: boolean | null;
  verificationSource:
    | "dom_buybox"
    | "product_page_wallet_selector"
    | "card_api"
    | "none"
    | "unverified"
    | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  repricingAllowedReason: string | null;
  blockedBySafetyRule: string[] | null;
  validRegionsCount: number;
  totalRegionsCount: number;
  frontStatus: "VERIFIED" | "PARTIAL" | "UNVERIFIED";
  /** Новая сводка для decision chain: регионы -> минимум -> сравнение с Мин ₽ */
  minWalletPriceRub: number | null;
  minWalletRegion: string | null;
  minNoWalletPriceRub: number | null;
  minNoWalletRegion: string | null;
  sellerMinPriceRub: number | null;
  repricingDecision: "raise_price" | "no_change" | "insufficient_data";
  repricingStatus: "enough_data" | "insufficient_data" | "ambiguity_warning";
  repricingReason: string;
  recommendedCabinetPriceRub: number | null;
  safeModeRecommendationOnly: boolean;
  /** Buyer-side (primary регион): снимок или fallback-цепочка — главный источник для UI каталога. */
  buyer: BuyerSidePricesJson;
  /** Seller-side из кабинета (WbProduct). */
  seller: SellerSidePricesJson;
  showcaseRub: number | null;
  walletRub: number | null;
  nonWalletRub: number | null;
  priceRegular: number | null;
  sellerPriceRub: number | null;
  sellerDiscountPct: number | null;
  sellerDiscountPriceRub: number | null;
  unified: UnifiedPriceObservationJson;
};

function humanRegionLabel(
  dest: string,
  snapshotLabel: string | null | undefined,
): string {
  const fromFile = regionLabelForDest(dest || undefined);
  if (fromFile) {
    return fromFile;
  }
  const snap = snapshotLabel?.trim();
  if (snap) {
    return snap;
  }
  if (dest) {
    return `Регион (код ${dest})`;
  }
  return "Профиль по умолчанию";
}

function buyerSideHasSignal(b: BuyerSidePricesJson): boolean {
  return (
    b.walletRub != null ||
    b.nonWalletRub != null ||
    b.showcaseRub != null ||
    b.priceRegular != null
  );
}

/**
 * Primary buyer model для строки каталога: нормализованный снимок (как parse-probe),
 * иначе единая fallback-цепочка по WbProduct (без размазанных last* по коду).
 */
function catalogPrimaryBuyerSide(
  primarySnap: PriceSnapshot | null,
  p: WbProduct,
): BuyerSidePricesJson {
  if (primarySnap != null) {
    const fromSnap = buildBuyerSideFromPriceSnapshot(primarySnap);
    if (buyerSideHasSignal(fromSnap)) return fromSnap;
  }
  return buildBuyerSideFromWbProductFallbackChain(p);
}

/**
 * Снимок по коду региона (dest).
 * Важно: не подставлять ключ "" для чужого dest — иначе один старый снимок без региона дублируется во все строки выбранных регионов.
 * Легаси: если в БД ровно один снимок и он с пустым dest — используем его для любого выбранного региона (до перезапуска мониторинга).
 */
function snapshotForDest(perDest: Map<string, PriceSnapshot>, dest: string): PriceSnapshot | undefined {
  const key = dest.trim();
  if (key.length > 0) {
    const direct = perDest.get(key);
    if (direct) return direct;
    if (perDest.size === 1) {
      const [onlyKey, snap] = [...perDest.entries()][0]!;
      if (onlyKey === "") return snap;
    }
    return undefined;
  }
  return perDest.get("");
}

function pricingStatusHintForRow(
  p: WbProduct,
  fixedOrMinRub: number | null,
  /** Итог только из последнего снимка по основному региону (без подстановки last* с карточки продукта). */
  primarySnapshotBuyerFinal: number | null,
): string | null {
  if (p.buyerParseEnabled === false) {
    return "Парсинг отключён — товар не участвует в мониторинге и защите по витрине";
  }
  const hasMin = fixedOrMinRub != null && Number.isFinite(fixedOrMinRub) && fixedOrMinRub > 0;
  if (p.stock != null && p.stock <= 0) {
    const src = p.lastPriceSource?.trim() ?? "";
    const usedFallbackSource =
      src.includes("fallback") || src === "mixed" || src === "fallback_floor";
    if (primarySnapshotBuyerFinal == null || usedFallbackSource) {
      return "Нет остатка — используется последняя известная / защитная цена";
    }
    return null;
  }
  if ((p.stock == null || p.stock > 0) && primarySnapshotBuyerFinal == null && hasMin) {
    return "Витрина недоступна, но правило минимальной цены сохранено";
  }
  return null;
}

/**
 * Обогащение строк каталога для `/api/catalog/products*`.
 *
 * **Источник truth (buyer):** нормализованный `PriceSnapshot` (как parse-probe) через
 * `buildBuyerSideFromPriceSnapshot`; при пустом снимке — `buildBuyerSideFromWbProductFallbackChain`
 * (кэш карточки → walletRubLastGood → legacy last*).
 *
 * **Seller:** только кабинет `WbProduct` → `buildSellerSideFromWbProduct`.
 *
 * **Legacy:** `showcaseFinalRub`, `lastWalletObservedRub` и др. остаются в spread `...p` для совместимости,
 * но колонки API/UI должны опираться на `buyer`, `seller`, `unified` и плоские дубликаты.
 */
export async function enrichProductsForTable(
  items: Array<WbProduct & { minPriceRule: MinPriceRule | null }>,
  selectedDests: string[],
): Promise<ProductTableRow[]> {
  const ids = items.map((p) => p.id);
  if (ids.length === 0) return [];

  const fixedAll = await prisma.fixedTargetPrice.findMany({
    where: { productId: { in: ids } },
    orderBy: { effectiveFrom: "desc" },
  });
  const fixedFirst = new Map<string, number>();
  for (const f of fixedAll) {
    if (!fixedFirst.has(f.productId)) {
      fixedFirst.set(f.productId, f.targetPrice);
    }
  }

  /**
   * Последний снимок на пару (productId, regionDest). Раньше JOIN по MAX(parsedAt) терял строки в SQLite,
   * если время «максимума» не совпадало с полем строки посимвольно — ROW_NUMBER надёжнее.
   */
  type SnapWithRn = PriceSnapshot & { rn: number };
  const rawSnaps = await prisma.$queryRaw<SnapWithRn[]>(Prisma.sql`
    SELECT * FROM (
      SELECT
        s.*,
        ROW_NUMBER() OVER (
          PARTITION BY s."productId", TRIM(COALESCE(s."regionDest", ''))
          ORDER BY s."parsedAt" DESC, s."id" DESC
        ) AS rn
      FROM "PriceSnapshot" s
      WHERE s."productId" IN (${Prisma.join(ids)})
    ) sub
    WHERE sub.rn = 1
  `);
  const snaps: PriceSnapshot[] = rawSnaps.map((row) => {
    const { rn: _drop, ...rest } = row;
    return rest as PriceSnapshot;
  });

  const latestByProdDest = new Map<string, Map<string, PriceSnapshot>>();
  for (const s of snaps) {
    const destKey = (s.regionDest ?? "").trim();
    if (!latestByProdDest.has(s.productId)) {
      latestByProdDest.set(s.productId, new Map());
    }
    const m = latestByProdDest.get(s.productId)!;
    if (!m.has(destKey)) {
      m.set(destKey, s);
    }
  }

  const destFilter =
    selectedDests.length > 0
      ? [...new Set(selectedDests.map((d) => d.trim()).filter(Boolean))]
      : null;

  return items.map((p) => {
    const ruleMin = p.minPriceRule?.minAllowedFinalPrice ?? null;
    const fixed = fixedFirst.get(p.id) ?? null;
    const fixedOrMinRub =
      ruleMin != null && Number.isFinite(ruleMin)
        ? ruleMin
        : fixed != null && Number.isFinite(fixed)
          ? fixed
          : null;

    const perDest = latestByProdDest.get(p.id) ?? new Map();
    let discBase: number | null = p.discountedPriceRub ?? p.sellerPrice ?? null;
    if (discBase == null || !Number.isFinite(discBase) || discBase <= 0) {
      for (const s of perDest.values()) {
        const v = s.sellerDiscountedSnapshotRub;
        if (v != null && Number.isFinite(v) && v > 0) {
          discBase = v;
          break;
        }
      }
    }

    let destOrder: string[];
    if (destFilter && destFilter.length > 0) {
      destOrder = destFilter;
    } else {
      destOrder = [...perDest.keys()];
      destOrder.sort((a, b) => {
        if (a === "" && b !== "") return 1;
        if (b === "" && a !== "") return -1;
        return (regionLabelForDest(a) || a).localeCompare(regionLabelForDest(b) || b, "ru");
      });
    }

    const regionBreakdown: RegionPriceRow[] = destOrder.map((d) => {
      const dNorm = d.trim();
      const s = snapshotForDest(perDest, dNorm);
      const label = humanRegionLabel(dNorm, s?.regionLabel);
      if (!s) {
        return {
          dest: dNorm,
          label,
          walletPriceRub: null,
          regularPriceRub: null,
          sppPercent: null,
          walletDiscountRub: null,
          sourceConfidence: null,
          source: null,
          verificationStatus: null,
          confidenceLevel: null,
          priceParseMode: null,
        };
      }
      const bs = buildBuyerSideFromPriceSnapshot(s);
      let walletPriceRub = bs.walletRub;
      let regularPriceRub = bs.nonWalletRub;
      ({ wallet: walletPriceRub, regular: regularPriceRub } = enforceWalletNotAboveSpp(
        walletPriceRub,
        regularPriceRub,
      ));
      ({ wallet: walletPriceRub, regular: regularPriceRub } = normalizeWalletVsRegularBySource(
        s,
        walletPriceRub,
        regularPriceRub,
      ));
      const meta = snapshotPriceMeta(s, walletPriceRub, regularPriceRub);
      const vm = buyerVerificationMeta(s);
      const sppPercent = meta.sppPercent;
      return {
        dest: dNorm,
        label,
        walletPriceRub,
        regularPriceRub,
        sppPercent,
        walletDiscountRub: meta.walletDiscountRub,
        sourceConfidence: meta.sourceConfidence,
        source: snapshotSource(s),
        verificationStatus: vm.verificationStatus,
        confidenceLevel: vm.confidence,
        priceParseMode: meta.priceParseMode,
      };
    });

    const finals = regionBreakdown
      .filter(
        (r) =>
          r.verificationStatus === "VERIFIED" &&
          (r.confidenceLevel === "HIGH" || r.confidenceLevel === "MEDIUM") &&
          r.walletPriceRub != null &&
          r.walletPriceRub > 0,
      )
      .map((r) => r.walletPriceRub as number);
    let sppPercentFromDiscounted = regionBreakdown
      .map((r) => r.sppPercent)
      .find((v) => v != null && Number.isFinite(v)) ?? null;
    const catalogPriceHeadline = buildCatalogPriceHeadline(regionBreakdown, discBase);
    if (catalogPriceHeadline?.sppPercent != null && Number.isFinite(catalogPriceHeadline.sppPercent)) {
      sppPercentFromDiscounted = catalogPriceHeadline.sppPercent;
    }

    const primaryDestRaw =
      destFilter && destFilter.length > 0
        ? destFilter[0]!
        : destOrder.find((d) => snapshotForDest(perDest, d.trim()) != null) ?? destOrder[0] ?? null;
    const primaryDest = primaryDestRaw != null ? primaryDestRaw.trim() : null;
    let primaryRegion: PrimaryRegionPrices | null = null;
    let primarySnapshot: PriceSnapshot | null = null;
    if (primaryDest != null) {
      const primarySnap = snapshotForDest(perDest, primaryDest);
      primarySnapshot = primarySnap ?? null;
      const row = regionBreakdown.find((r) => r.dest === primaryDest);
      if (row) {
        primaryRegion = {
          dest: row.dest,
          label: row.label,
          walletPriceRub: row.walletPriceRub,
          regularPriceRub: row.regularPriceRub,
          sppPercent: row.sppPercent,
          walletDiscountRub: row.walletDiscountRub,
          sourceConfidence: row.sourceConfidence,
          priceParseMode: row.priceParseMode,
        };
      } else {
        primaryRegion = {
          dest: primaryDest,
          label: humanRegionLabel(primaryDest, undefined),
          walletPriceRub: null,
          regularPriceRub: null,
          sppPercent: null,
          walletDiscountRub: null,
          sourceConfidence: null,
          priceParseMode: null,
        };
      }
      const hasSnapshotPrices =
        (primaryRegion.walletPriceRub != null && primaryRegion.walletPriceRub > 0) ||
        (primaryRegion.regularPriceRub != null && primaryRegion.regularPriceRub > 0);
      if (!hasSnapshotPrices) {
        const fb = catalogPrimaryBuyerSide(primarySnapshot, p);
        let walletPriceRub =
          primaryRegion.walletPriceRub ?? fb.walletRub ?? fb.showcaseRub ?? null;
        let regularPriceRub = primaryRegion.regularPriceRub ?? fb.nonWalletRub ?? null;
        ({ wallet: walletPriceRub, regular: regularPriceRub } = enforceWalletNotAboveSpp(
          walletPriceRub,
          regularPriceRub,
        ));
        const walletDiscountRub =
          walletPriceRub != null && regularPriceRub != null
            ? Math.max(0, Math.round(regularPriceRub - walletPriceRub))
            : null;
        const sppPercent = null;
        primaryRegion = {
          ...primaryRegion,
          walletPriceRub,
          regularPriceRub,
          sppPercent,
          walletDiscountRub,
          sourceConfidence: null,
          priceParseMode: "fallback",
        };
      }
      if (sppPercentFromDiscounted == null && primaryRegion.sppPercent != null) {
        sppPercentFromDiscounted = primaryRegion.sppPercent;
      }
    }

    const seller = buildSellerSideFromWbProduct(p);
    const buyerPrimary = catalogPrimaryBuyerSide(primarySnapshot, p);
    const unified = buildUnifiedObservation(seller, buyerPrimary, {
      region: primaryRegion?.label ?? null,
      dest: primaryDest != null ? destStringToNumber(primaryDest) : null,
    });

    const primaryBuyerFinalForHint =
      unified.buyer.walletRub ?? unified.buyer.nonWalletRub ?? unified.buyer.showcaseRub ?? null;

    let showcaseFinalRub = finals.length > 0 ? Math.min(...finals) : null;
    if (showcaseFinalRub == null) {
      showcaseFinalRub = unified.buyer.walletRub ?? unified.buyer.showcaseRub ?? null;
    }

    const pricingStatusHint = pricingStatusHintForRow(p, fixedOrMinRub, primaryBuyerFinalForHint);
    const verificationMeta = buyerVerificationMeta(primarySnapshot);
    const totalRegionsCount = regionBreakdown.length;
    const validRegionsCount = regionBreakdown.filter(
      (r) =>
        r.verificationStatus === "VERIFIED" &&
        (r.confidenceLevel === "HIGH" || r.confidenceLevel === "MEDIUM") &&
        r.walletPriceRub != null &&
        r.priceParseMode !== "fallback",
    ).length;
    const frontStatus: "VERIFIED" | "PARTIAL" | "UNVERIFIED" =
      validRegionsCount <= 0
        ? "UNVERIFIED"
        : validRegionsCount < Math.max(totalRegionsCount, 1)
          ? "PARTIAL"
          : "VERIFIED";
    const safeModeRecommendationOnly = ["1", "true", "yes", "on"].includes(
      env.REPRICER_ENFORCE_CRON_DRY_RUN.trim().toLowerCase(),
    );
    const repricingSummary = computeRepricingSummary({
      regions: regionBreakdown,
      sellerMinPriceRub: fixedOrMinRub,
      sellerCabinetPriceRub: p.sellerPrice,
      safeModeRecommendationOnly,
    });

    return {
      ...p,
      fixedOrMinRub,
      showcaseFinalRub,
      sppPercentFromDiscounted,
      regionBreakdown,
      primaryRegion,
      catalogPriceHeadline,
      pricingStatusHint,
      buyerVerificationStatus: verificationMeta.verificationStatus,
      buyerVerificationReason: verificationMeta.verificationReason,
      repricingAllowed: verificationMeta.repricingAllowed,
      verificationSource: verificationMeta.verificationSource,
      confidence: verificationMeta.confidence,
      repricingAllowedReason: verificationMeta.repricingAllowedReason,
      blockedBySafetyRule: verificationMeta.blockedBySafetyRule,
      validRegionsCount,
      totalRegionsCount,
      frontStatus,
      minWalletPriceRub: repricingSummary.minWalletPriceRub,
      minWalletRegion: repricingSummary.minWalletRegion,
      minNoWalletPriceRub: repricingSummary.minNoWalletPriceRub,
      minNoWalletRegion: repricingSummary.minNoWalletRegion,
      sellerMinPriceRub: repricingSummary.sellerMinPriceRub,
      repricingDecision: repricingSummary.repricingDecision,
      repricingStatus: repricingSummary.repricingStatus,
      repricingReason: repricingSummary.repricingReason,
      recommendedCabinetPriceRub: repricingSummary.recommendedCabinetPriceRub,
      safeModeRecommendationOnly,
      buyer: unified.buyer,
      seller: unified.seller,
      showcaseRub: unified.buyer.showcaseRub,
      walletRub: unified.buyer.walletRub,
      nonWalletRub: unified.buyer.nonWalletRub,
      priceRegular: unified.buyer.priceRegular,
      sellerPriceRub: unified.seller.sellerPriceRub,
      sellerDiscountPct: unified.seller.sellerDiscountPct,
      sellerDiscountPriceRub: unified.seller.sellerDiscountPriceRub,
      unified,
    };
  });
}
