import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from "@tanstack/react-table";
import { ApiError, apiFetch } from "../lib/api";

type PriceParseMode = "details_modal" | "network" | "dom_only" | "fallback" | "unverified";

type PrimaryRegion = {
  dest: string;
  label: string;
  walletPriceRub: number | null;
  regularPriceRub: number | null;
  sppPercent: number | null;
  walletDiscountRub: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  priceParseMode: PriceParseMode | null;
};

type UnifiedPricePayload = {
  seller: {
    sellerPriceRub: number | null;
    sellerDiscountPct: number | null;
    sellerDiscountPriceRub: number | null;
  };
  buyer: {
    showcaseRub: number | null;
    walletRub: number | null;
    nonWalletRub: number | null;
    priceRegular: number | null;
  };
  region?: string | null;
  dest?: number | null;
};

/** Сводка каталога: цена WB Кошелёк и «с СПП» из одного региона (где минимальный WB) */
type CatalogPriceHeadline = {
  dest: string;
  label: string;
  walletPriceRub: number | null;
  regularPriceRub: number | null;
  sppPercent: number | null;
  walletDiscountRub: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  priceParseMode: PriceParseMode | null;
};

function enforceWalletSppOrder(
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
    /** В UI не меняем местами WB/СПП: при конфликте СПП прячем, WB оставляем как есть. */
    return { wallet, regular: null };
  }
  return { wallet, regular };
}

/**
 * Цифры для колонок «WB / СПП / %»: при наличии headline — строго из одного региона; иначе прежний min по регионам.
 */
function catalogPriceSummary(r: ProductRow): {
  walletRub: number | null;
  withoutWalletRub: number | null;
  walletDiscountRub: number | null;
  sppPct: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  priceParseMode: PriceParseMode | null;
  footnote: string | null;
} {
  const h = r.catalogPriceHeadline;
  const br = r.regionBreakdown;
  const regionCount = br?.length ?? 0;

  /**
   * Главная колонка цен: verified headline по регионам.
   * Иначе — поля unified.buyer с сервера (не пересчитываем buyer из legacy last*).
   */
  if (h != null) {
    let w = h.walletPriceRub != null && h.walletPriceRub > 0 ? Math.round(h.walletPriceRub) : null;
    let reg = h.regularPriceRub != null && h.regularPriceRub > 0 ? Math.round(h.regularPriceRub) : null;
    ({ wallet: w, regular: reg } = enforceWalletSppOrder(w, reg));
    const sppPct = h.sppPercent != null && Number.isFinite(h.sppPercent) ? h.sppPercent : null;
    const walletDiscountRub =
      h.walletDiscountRub != null && Number.isFinite(h.walletDiscountRub)
        ? h.walletDiscountRub
        : w != null && reg != null
          ? Math.max(0, reg - w)
          : null;
    const footnote =
      regionCount > 1
        ? `сводка: ${h.label} (мин. витрина среди ${regionCount} регионов)`
        : null;
    return {
      walletRub: w,
      withoutWalletRub: reg,
      walletDiscountRub,
      sppPct,
      sourceConfidence: h.sourceConfidence ?? null,
      priceParseMode: h.priceParseMode ?? null,
      footnote,
    };
  }

  const ub = r.unified?.buyer;
  const walletVals =
    br?.map((x) => x.walletPriceRub).filter((v): v is number => v != null && Number.isFinite(v) && v > 0) ?? [];
  const regVals =
    br?.map((x) => x.regularPriceRub).filter((v): v is number => v != null && Number.isFinite(v) && v > 0) ?? [];

  let walletRub =
    ub?.walletRub != null && ub.walletRub > 0
      ? Math.round(ub.walletRub)
      : r.walletRub != null && r.walletRub > 0
        ? Math.round(r.walletRub)
        : walletVals.length > 0
          ? Math.min(...walletVals)
          : r.primaryRegion?.walletPriceRub != null && r.primaryRegion.walletPriceRub > 0
            ? Math.round(r.primaryRegion.walletPriceRub)
            : r.lastWalletObservedRub != null && r.lastWalletObservedRub > 0
              ? Math.round(r.lastWalletObservedRub)
              : null;
  let regularRub =
    ub?.nonWalletRub != null && ub.nonWalletRub > 0
      ? Math.round(ub.nonWalletRub)
      : r.nonWalletRub != null && r.nonWalletRub > 0
        ? Math.round(r.nonWalletRub)
        : regVals.length > 0
          ? Math.min(...regVals)
          : r.primaryRegion?.regularPriceRub != null && r.primaryRegion.regularPriceRub > 0
            ? Math.round(r.primaryRegion.regularPriceRub)
            : r.lastRegularObservedRub != null && r.lastRegularObservedRub > 0
              ? Math.round(r.lastRegularObservedRub)
              : null;
  ({ wallet: walletRub, regular: regularRub } = enforceWalletSppOrder(walletRub, regularRub));

  const sppPct = r.sppPercentFromDiscounted ?? r.primaryRegion?.sppPercent ?? null;
  const walletDiscountRub =
    r.primaryRegion?.walletDiscountRub != null
      ? r.primaryRegion.walletDiscountRub
      : walletRub != null && regularRub != null
        ? Math.max(0, regularRub - walletRub)
        : null;

  const footnote =
    regionCount > 1 ? `мин. среди ${regionCount} выбранных регионов (разные склады)` : null;
  return {
    walletRub,
    withoutWalletRub: regularRub,
    walletDiscountRub,
    sppPct,
    sourceConfidence: r.primaryRegion?.sourceConfidence ?? null,
    priceParseMode: r.primaryRegion?.priceParseMode ?? null,
    footnote,
  };
}

/** Строка из enrichProductsForTable: цены по одному dest из последнего мониторинга */
type RegionBreakdownRow = {
  dest: string;
  label: string;
  walletPriceRub: number | null;
  regularPriceRub: number | null;
  sppPercent: number | null;
  walletDiscountRub: number | null;
  sourceConfidence: "high" | "medium" | "low" | null;
  source?: string | null;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | null;
  confidenceLevel: "HIGH" | "MEDIUM" | "LOW" | null;
  priceParseMode: PriceParseMode | null;
};

type ProductRow = {
  id: string;
  nmId: number;
  title: string;
  brand?: string | null;
  subjectName?: string | null;
  vendorCode?: string | null;
  stock?: number | null;
  sellerPrice?: number | null;
  discountedPriceRub?: number | null;
  lastWalletObservedRub?: number | null;
  lastRegularObservedRub?: number | null;
  lastEvaluationStatus?: string | null;
  lastWalletParseStatus?: string | null;
  lastParseConfidence?: number | null;
  lastMonitorAt?: string | null;
  lastMonitorRegionDest?: string | null;
  buyerParseEnabled?: boolean;
  minPriceRule?: { controlEnabled: boolean; minAllowedFinalPrice: number } | null;
  fixedOrMinRub?: number | null;
  sppPercentFromDiscounted?: number | null;
  primaryRegion?: PrimaryRegion | null;
  catalogPriceHeadline?: CatalogPriceHeadline | null;
  /** Все выбранные регионы с последними снимками (WB, с СПП, % СПП) */
  regionBreakdown?: RegionBreakdownRow[];
  pricingStatusHint?: string | null;
  buyerVerificationStatus?: "VERIFIED" | "UNVERIFIED" | null;
  buyerVerificationReason?: string | null;
  repricingAllowed?: boolean | null;
  verificationSource?: "popup_dom" | "popup_network" | "dom_buybox" | "card_api" | "none" | "unverified" | null;
  confidence?: "HIGH" | "MEDIUM" | "LOW" | null;
  repricingAllowedReason?: string | null;
  blockedBySafetyRule?: string[] | null;
  validRegionsCount?: number;
  totalRegionsCount?: number;
  frontStatus?: "VERIFIED" | "PARTIAL" | "UNVERIFIED";
  minWalletPriceRub?: number | null;
  minWalletRegion?: string | null;
  minNoWalletPriceRub?: number | null;
  minNoWalletRegion?: string | null;
  sellerMinPriceRub?: number | null;
  repricingDecision?: "raise_price" | "no_change" | "insufficient_data";
  repricingStatus?: "enough_data" | "insufficient_data" | "ambiguity_warning";
  repricingReason?: string | null;
  recommendedCabinetPriceRub?: number | null;
  safeModeRecommendationOnly?: boolean;
  showcaseRub?: number | null;
  walletRub?: number | null;
  nonWalletRub?: number | null;
  priceRegular?: number | null;
  sellerPriceRub?: number | null;
  sellerDiscountPct?: number | null;
  sellerDiscountPriceRub?: number | null;
  buyer?: UnifiedPricePayload["buyer"];
  seller?: UnifiedPricePayload["seller"];
  unified?: UnifiedPricePayload;
};

type ListResponse = {
  total: number;
  items: ProductRow[];
  selectedRegionDests: string[];
  catalogHint?: string;
  safeModeRecommendationOnly?: boolean;
};

type WbRegionItem = { dest: string; name: string; id?: string };

function fmtRub(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v)}`;
}

function RegionBreakdownCell({ row }: { row: ProductRow }) {
  const br = row.regionBreakdown;
  if (br && br.length > 0) {
    const walletVals = br
      .map((x) => (x.walletPriceRub != null && x.walletPriceRub > 0 ? Math.round(x.walletPriceRub) : null))
      .filter((v): v is number => v != null);
    const withoutVals = br
      .map((x) => (x.regularPriceRub != null && x.regularPriceRub > 0 ? Math.round(x.regularPriceRub) : null))
      .filter((v): v is number => v != null);
    const walletUnique = new Set(walletVals);
    const withoutUnique = new Set(withoutVals);
    const hasNonModalSource = br.some((x) => x.priceParseMode !== "details_modal");
    const walletLooksNonRegional =
      walletUnique.size === 1 && withoutUnique.size > 1 && hasNonModalSource;

    const hasAny = br.some(
      (x) =>
        (x.walletPriceRub != null && x.walletPriceRub > 0) ||
        (x.regularPriceRub != null && x.regularPriceRub > 0),
    );
    if (!hasAny) {
      const ub = row.unified?.buyer;
      let fallbackWallet =
        ub?.walletRub != null && ub.walletRub > 0
          ? Math.round(ub.walletRub)
          : row.walletRub != null && row.walletRub > 0
            ? Math.round(row.walletRub)
            : row.lastWalletObservedRub != null && row.lastWalletObservedRub > 0
              ? Math.round(row.lastWalletObservedRub)
              : null;
      let fallbackSppPrice =
        ub?.nonWalletRub != null && ub.nonWalletRub > 0
          ? Math.round(ub.nonWalletRub)
          : row.nonWalletRub != null && row.nonWalletRub > 0
            ? Math.round(row.nonWalletRub)
            : row.lastRegularObservedRub != null && row.lastRegularObservedRub > 0
              ? Math.round(row.lastRegularObservedRub)
              : null;
      ({ wallet: fallbackWallet, regular: fallbackSppPrice } = enforceWalletSppOrder(
        fallbackWallet,
        fallbackSppPrice,
      ));
      if (fallbackSppPrice != null || fallbackWallet != null) {
        const w = fallbackWallet != null ? `${fmtRub(fallbackWallet)} ₽` : "—";
        const f = fallbackSppPrice != null ? `${fmtRub(fallbackSppPrice)} ₽` : "—";
        return (
          <div className="max-w-[240px] text-xs leading-snug">
            <div className="font-medium text-[#e8eaef]">Последний мониторинг</div>
            <div className="text-[#8b93a7]">
              С кошельком: <span className="text-emerald-200/85">{w}</span> · Без кошелька:{" "}
              <span className="text-[#c4c9d4]">{f}</span>
            </div>
            <div className="mt-1 text-[10px] text-[#8b93a7]">
              По выбранным регионам ещё нет снимков
            </div>
          </div>
        );
      }
      return (
        <span className="text-xs text-[#8b93a7]">
          Нет снимков по выбранным регионам — запустите мониторинг (и проверьте сессию покупателя)
        </span>
      );
    }
    return (
      <div className="max-w-[min(440px,100%)] space-y-2 text-[11px] leading-snug">
        {walletLooksNonRegional ? (
          <div className="rounded border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-100">
            Цена «С кошельком» не подтверждена по регионам (одинаковая при разных ценах без кошелька).
            Показываю найденное verified DOM-значение с пометкой «*».
          </div>
        ) : null}
        {br.map((reg) => {
          const walletDisplayRub =
            reg.walletPriceRub != null &&
            reg.walletPriceRub > 0 &&
            reg.verificationStatus === "VERIFIED"
              ? reg.walletPriceRub
              : null;
          const w = walletDisplayRub != null ? `${fmtRub(walletDisplayRub)} ₽` : "—";
          const showUnconfirmedMark = walletLooksNonRegional && walletDisplayRub != null;
          const sppRub = reg.regularPriceRub != null && reg.regularPriceRub > 0 ? reg.regularPriceRub : null;
          const f = sppRub != null ? `${fmtRub(sppRub)} ₽` : "—";
          const key = `${reg.dest}\0${reg.label}`;
          return (
            <div
              key={key}
              className="border-b border-[#252a33]/60 pb-2 last:border-b-0 last:pb-0"
            >
              <div className="font-medium text-[#e8eaef]">{reg.label}</div>
              <div className="text-[#8b93a7]">
                С кошельком:{" "}
                <span className="text-emerald-200/85">
                  {w}
                  {showUnconfirmedMark ? (
                    <span
                      className="ml-0.5 text-amber-300"
                      title="Цена с кошельком найдена и verified, но пока не подтверждена как уникально региональная. Показано общее DOM-значение."
                    >
                      *
                    </span>
                  ) : null}
                </span>{" "}
                · Без кошелька:{" "}
                <span className="text-[#c4c9d4]">{f}</span>
              </div>
              <div className="text-[10px] text-[#8b93a7]">
                verify: {reg.verificationStatus ?? "—"} · conf: {reg.confidenceLevel ?? "—"} · mode:{" "}
                {reg.priceParseMode ?? "—"} · source: {reg.source ?? "—"}
              </div>
            </div>
          );
        })}
        {walletLooksNonRegional ? (
          <div
            className="rounded border border-amber-400/20 bg-amber-400/5 px-2 py-1 text-[10px] text-amber-100/90"
            title="Цена с кошельком найдена и verified, но пока не подтверждена как уникально региональная. Показано общее DOM-значение."
          >
            * Цена с кошельком найдена и verified, но пока не подтверждена как уникально региональная. Показано общее DOM-значение.
          </div>
        ) : null}
      </div>
    );
  }

  const pr = row.primaryRegion;
  const ubRow = row.unified?.buyer;
  let wRub =
    ubRow?.walletRub != null && ubRow.walletRub > 0
      ? Math.round(ubRow.walletRub)
      : row.walletRub != null && row.walletRub > 0
        ? Math.round(row.walletRub)
        : pr?.walletPriceRub ??
          (row.lastWalletObservedRub != null && row.lastWalletObservedRub > 0
            ? Math.round(row.lastWalletObservedRub)
            : null);
  let fRub =
    ubRow?.nonWalletRub != null && ubRow.nonWalletRub > 0
      ? Math.round(ubRow.nonWalletRub)
      : row.nonWalletRub != null && row.nonWalletRub > 0
        ? Math.round(row.nonWalletRub)
        : pr?.regularPriceRub ??
          (row.lastRegularObservedRub != null && row.lastRegularObservedRub > 0
            ? Math.round(row.lastRegularObservedRub)
            : null);
  ({ wallet: wRub, regular: fRub } = enforceWalletSppOrder(wRub, fRub));
  const destKey = pr?.dest ?? row.lastMonitorRegionDest ?? "";
  const displayLabel =
    pr?.label ?? (destKey ? `Регион (код ${destKey})` : "Последний мониторинг");

  if (fRub == null && wRub == null) {
    return <span className="text-xs text-[#8b93a7]">Нет данных мониторинга</span>;
  }
  const w = wRub != null ? `${fmtRub(wRub)} ₽` : "—";
  const sppRub =
    ubRow?.nonWalletRub != null && ubRow.nonWalletRub > 0
      ? ubRow.nonWalletRub
      : row.nonWalletRub != null && row.nonWalletRub > 0
        ? row.nonWalletRub
        : pr?.regularPriceRub != null && pr.regularPriceRub > 0
          ? pr.regularPriceRub
          : row.lastRegularObservedRub != null && row.lastRegularObservedRub > 0
            ? Math.round(row.lastRegularObservedRub)
            : null;
  const f = sppRub != null ? `${fmtRub(sppRub)} ₽` : "—";
  return (
    <div className="max-w-[320px] text-xs leading-snug">
      <div className="font-medium text-[#e8eaef]">{displayLabel}</div>
      <div className="text-[#8b93a7]">
        С кошельком: <span className="text-emerald-200/85">{w}</span> · Без кошелька:{" "}
        <span className="text-[#c4c9d4]">{f}</span>
      </div>
    </div>
  );
}

function MinPriceCell({
  nmId,
  minFromRule,
  fixedOrMinFallback,
  queryClient,
}: {
  nmId: number;
  minFromRule: number | null | undefined;
  fixedOrMinFallback: number | null | undefined;
  queryClient: QueryClient;
}) {
  const serverVal = minFromRule ?? fixedOrMinFallback;
  const [draft, setDraft] = useState(() =>
    serverVal != null && Number.isFinite(serverVal) ? String(Math.round(serverVal)) : "",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const v = minFromRule ?? fixedOrMinFallback;
    setDraft(v != null && Number.isFinite(v) ? String(Math.round(v)) : "");
    setErr(null);
  }, [nmId, minFromRule, fixedOrMinFallback]);

  async function save() {
    const n = Number(String(draft).replace(",", ".").trim());
    if (!Number.isFinite(n) || n <= 0) {
      setErr("Введите число > 0");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await apiFetch(`/api/products/${nmId}/min-rule`, {
        method: "PATCH",
        json: { minAllowedFinalPrice: n },
      });
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-[118px] flex-col gap-0.5 bg-[#0c0e12]">
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="мин."
          aria-label={`Минимальная цена nm ${nmId}`}
          className="w-[4.75rem] rounded border border-[#252a33] bg-[#0c0e12] px-1.5 py-1 text-xs text-white placeholder:text-[#5c6578]"
        />
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="shrink-0 rounded bg-blue-600/85 px-2 py-1 text-xs text-white hover:bg-blue-600 disabled:opacity-40"
        >
          {saving ? "…" : "OK"}
        </button>
      </div>
      {err ? (
        <span className="max-w-[7.5rem] text-[10px] leading-tight text-red-400">{err}</span>
      ) : null}
    </div>
  );
}

function BuyerParseToggle({
  nmId,
  buyerParseEnabled,
  queryClient,
}: {
  nmId: number;
  buyerParseEnabled: boolean | undefined;
  queryClient: QueryClient;
}) {
  const enabled = buyerParseEnabled !== false;
  const [v, setV] = useState(enabled);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setV(buyerParseEnabled !== false);
    setErr(null);
  }, [nmId, buyerParseEnabled]);

  async function apply(next: boolean) {
    setPending(true);
    setErr(null);
    try {
      await apiFetch(`/api/products/${nmId}/buyer-parse`, {
        method: "PATCH",
        json: { buyerParseEnabled: next },
      });
      setV(next);
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-w-[120px] flex-col gap-0.5">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-[#c4c9d4]">
        <input
          type="checkbox"
          checked={v}
          disabled={pending}
          onChange={(e) => void apply(e.target.checked)}
          aria-label={`Парсинг nm ${nmId}`}
          className="rounded border-[#252a33] bg-[#0c0e12]"
        />
        <span>{v ? "Вкл." : "Выкл."}</span>
      </label>
      {err ? <span className="text-[10px] text-red-400">{err}</span> : null}
    </div>
  );
}

export function CatalogPage() {
  const qc = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [brandChoice, setBrandChoice] = useState("");
  const [stock, setStock] = useState<"" | "with" | "without">("");
  const [belowMin, setBelowMin] = useState(false);
  const [parseFailed, setParseFailed] = useState(false);
  const [buyerParseFilter, setBuyerParseFilter] = useState<"" | "on" | "off">("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const regionsQ = useQuery({
    queryKey: ["regions"],
    queryFn: () => apiFetch<{ items: WbRegionItem[] }>("/api/regions"),
  });

  const destToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of regionsQ.data?.items ?? []) {
      m.set(r.dest, r.name || r.dest);
    }
    return m;
  }, [regionsQ.data]);

  const brandsQ = useQuery({
    queryKey: ["catalog-brands"],
    queryFn: () => apiFetch<{ items: string[] }>("/api/catalog/brands"),
  });

  const listQ = useQuery({
    queryKey: ["catalog", debouncedSearch, brandChoice, stock, belowMin, parseFailed, buyerParseFilter],
    queryFn: () => {
      const q = new URLSearchParams();
      if (debouncedSearch) q.set("search", debouncedSearch);
      if (brandChoice) {
        q.set("brand", brandChoice);
        q.set("brandExact", "true");
      }
      if (stock === "with") q.set("stock", "with");
      if (stock === "without") q.set("stock", "without");
      if (belowMin) q.set("belowMin", "true");
      if (parseFailed) q.set("parseFailed", "true");
      if (buyerParseFilter === "on") q.set("buyerParse", "true");
      if (buyerParseFilter === "off") q.set("buyerParse", "false");
      q.set("limit", "100");
      return apiFetch<ListResponse>(`/api/catalog/products-v2?${q.toString()}`);
    },
  });

  const bulkControl = useMutation({
    mutationFn: async (p: { ids: string[]; controlEnabled: boolean }) => {
      if (!p.ids.length) return;
      await apiFetch("/api/catalog/bulk-control", {
        method: "POST",
        json: { productIds: p.ids, controlEnabled: p.controlEnabled },
      });
    },
    onSuccess: () => {
      setRowSelection({});
      void qc.invalidateQueries({ queryKey: ["catalog"] });
    },
  });

  const bulkBuyerParse = useMutation({
    mutationFn: async (p: { ids: string[]; buyerParseEnabled: boolean }) => {
      if (!p.ids.length) return;
      await apiFetch("/api/catalog/bulk-buyer-parse", {
        method: "POST",
        json: { productIds: p.ids, buyerParseEnabled: p.buyerParseEnabled },
      });
    },
    onSuccess: () => {
      setRowSelection({});
      void qc.invalidateQueries({ queryKey: ["catalog"] });
    },
  });

  const columns = useMemo<ColumnDef<ProductRow, unknown>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <input
            type="checkbox"
            checked={table.getIsAllPageRowsSelected()}
            ref={(el) => {
              if (el) {
                el.indeterminate =
                  table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
              }
            }}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
            className="rounded border-[#252a33] bg-[#0c0e12]"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onChange={row.getToggleSelectedHandler()}
            className="rounded border-[#252a33] bg-[#0c0e12]"
          />
        ),
        size: 32,
      },
      {
        id: "buyerParse",
        header: "Парсинг",
        size: 112,
        cell: ({ row }) => (
          <BuyerParseToggle
            nmId={row.original.nmId}
            buyerParseEnabled={row.original.buyerParseEnabled}
            queryClient={qc}
          />
        ),
      },
      { accessorKey: "nmId", header: "nmId", size: 88 },
      {
        accessorKey: "vendorCode",
        header: "Артикул",
        cell: (c) => c.getValue() ?? "—",
        size: 96,
      },
      {
        accessorKey: "title",
        header: "Товар",
        cell: (c) => <span className="line-clamp-2 max-w-[200px]">{String(c.getValue())}</span>,
      },
      { accessorKey: "brand", header: "Бренд", cell: (c) => c.getValue() ?? "—", size: 100 },
      {
        accessorKey: "stock",
        header: "Остаток",
        cell: (c) => {
          const v = c.getValue() as number | null | undefined;
          if (v == null) return <span className="text-[#8b93a7]">нет данных</span>;
          return v > 0 ? String(v) : "0";
        },
        size: 88,
      },
      {
        accessorKey: "sellerPrice",
        header: () => (
          <span title="Цена в ЛК — цена из кабинета продавца">
            Цена в ЛК
          </span>
        ),
        cell: (c) => (c.getValue() != null ? `${fmtRub(c.getValue() as number)} ₽` : "—"),
      },
      {
        accessorKey: "discountedPriceRub",
        header: () => (
          <span title="Цена со скидкой — цена продавца со скидкой">
            Цена со скидкой
          </span>
        ),
        cell: (c) => (c.getValue() != null ? `${fmtRub(c.getValue() as number)} ₽` : "—"),
      },
      {
        id: "buyerFinal",
        header: () => (
          <span title="Минимальная verified цена WB кошелька среди выбранных регионов">
            WB кошелек (мин)
          </span>
        ),
        accessorFn: (r) => r.minWalletPriceRub ?? catalogPriceSummary(r).walletRub,
        cell: ({ row }) => {
          const walletRub = row.original.minWalletPriceRub ?? catalogPriceSummary(row.original).walletRub;
          const footnote = row.original.minWalletRegion
            ? `минимум по региону: ${row.original.minWalletRegion}`
            : catalogPriceSummary(row.original).footnote;
          return (
            <div className="flex flex-col gap-0.5">
              <span>{walletRub != null ? `${fmtRub(walletRub)} ₽` : "—"}</span>
              {footnote ? (
                <span className="text-[10px] leading-tight text-[#8b93a7]">{footnote}</span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "minWalletRegion",
        header: () => <span title="Регион, где найден минимальный WB кошелек">Регион минимума</span>,
        accessorFn: (r) => r.minWalletRegion ?? "—",
        cell: ({ row }) => (
          <span className="text-xs text-[#c4c9d4]">{row.original.minWalletRegion ?? "—"}</span>
        ),
      },
      {
        id: "withoutWalletPrice",
        header: () => (
          <span title="Минимальная verified цена без кошелька среди выбранных регионов">
            Цена без кошелька (мин)
          </span>
        ),
        accessorFn: (r) => r.minNoWalletPriceRub ?? catalogPriceSummary(r).withoutWalletRub,
        cell: ({ row }) => {
          const withoutWalletRub =
            row.original.minNoWalletPriceRub ?? catalogPriceSummary(row.original).withoutWalletRub;
          return (
            <div className="flex flex-col gap-0.5">
              <span>{withoutWalletRub != null ? `${fmtRub(withoutWalletRub)} ₽` : "—"}</span>
              <span className="text-[10px] leading-tight text-[#8b93a7]">
                регион: {row.original.minNoWalletRegion ?? "—"}
              </span>
            </div>
          );
        },
      },
      {
        id: "sppPct",
        header: () => (
          <span title="% СПП — процент СПП от цены со скидкой">
            % СПП
          </span>
        ),
        accessorFn: (r) => {
          const { sppPct } = catalogPriceSummary(r);
          return sppPct;
        },
        cell: ({ row }) => {
          const r0 = row.original;
          let agg: number | null = catalogPriceSummary(r0).sppPct;
          if (agg == null || !Number.isFinite(agg)) {
            agg = null;
          }
          const br = r0.regionBreakdown?.filter((x) => x.sppPercent != null && Number.isFinite(x.sppPercent)) ?? [];
          const distinct = new Set(br.map((x) => Math.round((x.sppPercent as number) * 10) / 10));
          return (
            <div className="flex flex-col gap-0.5">
              <span>{agg != null ? `${agg}%` : "—"}</span>
              {br.length > 1 && distinct.size > 1 ? (
                <div className="text-[10px] leading-tight text-[#8b93a7]">
                  по регионам:{" "}
                  {br.map((x) => (
                    <span key={`spp-${x.dest}`} className="mr-1 inline-block">
                      {x.label.length > 14 ? `${x.label.slice(0, 14)}…` : x.label}: {x.sppPercent}%
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "minCol",
        header: "Мин. ₽",
        accessorFn: (r) => r.sellerMinPriceRub ?? r.minPriceRule?.minAllowedFinalPrice ?? r.fixedOrMinRub,
        cell: ({ row }) => (
          <MinPriceCell
            nmId={row.original.nmId}
            minFromRule={row.original.minPriceRule?.minAllowedFinalPrice}
            fixedOrMinFallback={row.original.fixedOrMinRub}
            queryClient={qc}
          />
        ),
        size: 140,
      },
      {
        id: "repricingDecision",
        header: "Решение",
        accessorFn: (r) => r.repricingDecision ?? "insufficient_data",
        cell: ({ row }) => {
          const decision = row.original.repricingDecision ?? "insufficient_data";
          const status = row.original.repricingStatus ?? "insufficient_data";
          const reason = row.original.repricingReason ?? "—";
          const color =
            decision === "raise_price"
              ? "text-amber-200"
              : decision === "no_change"
                ? "text-emerald-200"
                : "text-[#c4c9d4]";
          return (
            <div className="max-w-[260px] text-xs">
              <div className={color}>{decision}</div>
              <div className="text-[10px] text-[#8b93a7]">status: {status}</div>
              <div className="text-[10px] leading-tight text-[#8b93a7]">{reason}</div>
            </div>
          );
        },
        size: 220,
      },
      {
        id: "recommendedCabinetPriceRub",
        header: "Рекомендуемая новая цена в ЛК",
        accessorFn: (r) => r.recommendedCabinetPriceRub ?? null,
        cell: ({ row }) => {
          const rec = row.original.recommendedCabinetPriceRub;
          const safe = row.original.safeModeRecommendationOnly ?? false;
          return (
            <div className="flex flex-col gap-0.5 text-xs">
              <span>{rec != null ? `${fmtRub(rec)} ₽` : "—"}</span>
              {safe ? (
                <span className="text-[10px] text-amber-200/90">safe-mode: только рекомендация</span>
              ) : null}
            </div>
          );
        },
        size: 190,
      },
      {
        id: "regionCol",
        header: () => (
          <span title="По каждому выбранному региону — отдельный блок из последнего мониторинга.">
            Регионы
          </span>
        ),
        cell: ({ row }) => <RegionBreakdownCell row={row.original} />,
        size: 560,
      },
      {
        accessorKey: "lastEvaluationStatus",
        header: "Статус / confidence",
        size: 120,
        cell: ({ row, getValue }) => {
          const status = String(getValue() ?? "—");
          const summary = catalogPriceSummary(row.original);
          const verificationStatus = row.original.buyerVerificationStatus ?? null;
          const verificationReason = row.original.buyerVerificationReason ?? null;
          const verificationSource = row.original.verificationSource ?? "—";
          const confidence = row.original.confidence ?? "—";
          const repricingAllowedReason = row.original.repricingAllowedReason ?? null;
          const blockedBySafetyRule = row.original.blockedBySafetyRule ?? [];
          const validRegionsCount = row.original.validRegionsCount ?? 0;
          const totalRegionsCount = row.original.totalRegionsCount ?? 0;
          const frontStatus = row.original.frontStatus ?? "UNVERIFIED";
          const isUnverified = verificationStatus === "UNVERIFIED";
          return (
            <div className="flex max-w-[240px] flex-col gap-0.5">
              <span className="text-xs text-[#c4c9d4]">{status}</span>
              <span className="text-[10px] text-[#8b93a7]">
                conf: {summary.sourceConfidence ?? "—"} · mode: {summary.priceParseMode ?? "—"}
              </span>
              <span className={`text-[10px] ${isUnverified ? "text-amber-200/90" : "text-emerald-200/80"}`}>
                verify: {verificationStatus ?? "—"} · repricing:{" "}
                {row.original.repricingAllowed === true ? "allowed" : "blocked"}
              </span>
              <span className="text-[10px] text-[#8b93a7]">
                source: {verificationSource} · confidence: {confidence}
              </span>
              <span className="text-[10px] text-[#8b93a7]">
                trusted: {frontStatus} · valid regions: {validRegionsCount}/{totalRegionsCount}
              </span>
              {verificationReason ? (
                <span className="text-[10px] leading-tight text-amber-200/90">
                  reason: {verificationReason}
                </span>
              ) : null}
              {repricingAllowedReason ? (
                <span className="text-[10px] leading-tight text-amber-200/90">
                  repricingAllowedReason: {repricingAllowedReason}
                </span>
              ) : null}
              {blockedBySafetyRule.length > 0 ? (
                <span className="text-[10px] leading-tight text-red-300/90">
                  blockedBySafetyRule: {blockedBySafetyRule.join(", ")}
                </span>
              ) : null}
              {row.original.pricingStatusHint ? (
                <span className="text-[10px] leading-tight text-amber-200/90">
                  {row.original.pricingStatusHint}
                </span>
              ) : null}
            </div>
          );
        },
      },
    ],
    [qc],
  );

  const table = useReactTable({
    data: listQ.data?.items ?? [],
    columns,
    state: { rowSelection },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  function bulkIds() {
    return table.getSelectedRowModel().rows.map((r) => r.original.id);
  }

  const selectedDests = listQ.data?.selectedRegionDests ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Каталог</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">
          Витрина WB = цена <strong className="text-[#c4c9d4]">с WB Кошельком</strong>. Цена{" "}
          <strong className="text-[#c4c9d4]">без WB Кошелька</strong> считается как{" "}
          <strong className="text-[#c4c9d4]">sellerDiscountPriceRub − sppRub</strong>, где `sppRub` берётся из buyer session/cookies.
          Popup детализации используется как дополнительная проверка/debug. Данные появляются только после мониторинга.
        </p>
      </div>

      {listQ.data?.catalogHint ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {listQ.data.catalogHint}
        </div>
      ) : null}
      {listQ.data?.safeModeRecommendationOnly ? (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
          Включен безопасный режим: репрайсер считает рекомендации, но не отправляет запись цены в ЛК.
        </div>
      ) : null}

      {selectedDests.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#8b93a7]">
          <span>Регионы мониторинга:</span>
          {selectedDests.map((d) => (
            <span
              key={d}
              className="rounded-full border border-[#252a33] bg-[#13161c] px-2 py-0.5 text-[#c4c9d4]"
              title={d}
            >
              {destToName.get(d) ?? d}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[#8b93a7]">
          Поиск (название, nmId, артикул)
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-56 rounded-lg border border-[#252a33] bg-[#13161c] px-3 py-2 text-sm text-white"
            placeholder="Ввод…"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#8b93a7]">
          Бренд
          <select
            value={brandChoice}
            onChange={(e) => setBrandChoice(e.target.value)}
            className="min-w-[180px] rounded-lg border border-[#252a33] bg-[#13161c] px-3 py-2 text-sm text-white"
          >
            <option value="">Все бренды</option>
            {(brandsQ.data?.items ?? []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#8b93a7]">
          Остаток WB
          <select
            value={stock}
            onChange={(e) => setStock(e.target.value as "" | "with" | "without")}
            className="rounded-lg border border-[#252a33] bg-[#13161c] px-3 py-2 text-sm text-white"
          >
            <option value="">Все</option>
            <option value="with">С остатком (&gt;0)</option>
            <option value="without">Без остатка (0 или нет данных)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-[#c4c9d4]">
          <input type="checkbox" checked={belowMin} onChange={(e) => setBelowMin(e.target.checked)} />
          Ниже минимума
        </label>
        <label className="flex items-center gap-2 text-sm text-[#c4c9d4]">
          <input
            type="checkbox"
            checked={parseFailed}
            onChange={(e) => setParseFailed(e.target.checked)}
          />
          Ошибка парсинга
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#8b93a7]">
          Парсинг в мониторинге
          <select
            value={buyerParseFilter}
            onChange={(e) => setBuyerParseFilter(e.target.value as "" | "on" | "off")}
            className="rounded-lg border border-[#252a33] bg-[#13161c] px-3 py-2 text-sm text-white"
          >
            <option value="">Все товары</option>
            <option value="on">Только с парсингом</option>
            <option value="off">Только отключённые</option>
          </select>
        </label>
        <span className="text-sm text-[#8b93a7]">Всего: {listQ.data?.total ?? "—"}</span>
        <button
          type="button"
          onClick={() => {
            setSearchInput("");
            setDebouncedSearch("");
            setBrandChoice("");
            setStock("");
            setBelowMin(false);
            setParseFailed(false);
            setBuyerParseFilter("");
          }}
          className="rounded-lg border border-[#323842] bg-[#1a1f28] px-3 py-2 text-sm text-[#c4c9d4] hover:bg-[#252a33]"
        >
          Сбросить фильтры
        </button>
      </div>

      <div className="rounded-lg border border-[#252a33] bg-[#0c0e12]/80 px-4 py-3 text-xs text-[#8b93a7]">
        <strong className="text-[#c4c9d4]">Модель цен:</strong> `basePriceRub` и `sellerDiscountPriceRub` — из Seller API; `walletPriceRub`
        — из DOM витрины; `sppRub` — из buyer session/cookies; `priceWithoutWalletRub = sellerDiscountPriceRub - sppRub`; `walletDiscountRub = priceWithoutWalletRub - walletPriceRub`.
      </div>

      <div className="rounded-lg border border-blue-500/25 bg-blue-500/10 px-4 py-2 text-xs text-blue-100">
        <strong className="text-white">Минимальная цена:</strong> колонка{" "}
        <strong className="text-white">«Мин. ₽»</strong> стоит после «WB Кошелёк» — введите сумму и{" "}
        <strong className="text-white">OK</strong> (или Enter). Устаревший интерфейс:{" "}
        <code className="rounded bg-black/30 px-1">npm run build:web</code> или <code className="rounded bg-black/30 px-1">npm start</code>.
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={bulkControl.isPending}
          onClick={() => bulkControl.mutate({ ids: bulkIds(), controlEnabled: true })}
          className="rounded-lg bg-emerald-600/80 px-3 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          Включить контроль (выбранные)
        </button>
        <button
          type="button"
          disabled={bulkControl.isPending}
          onClick={() => bulkControl.mutate({ ids: bulkIds(), controlEnabled: false })}
          className="rounded-lg bg-[#252a33] px-3 py-2 text-sm text-white hover:bg-[#323842] disabled:opacity-40"
        >
          Выключить контроль
        </button>
        <button
          type="button"
          disabled={bulkBuyerParse.isPending}
          onClick={() => bulkBuyerParse.mutate({ ids: bulkIds(), buyerParseEnabled: true })}
          className="rounded-lg border border-emerald-600/40 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-900/35 disabled:opacity-40"
        >
          Включить парсинг (выбранные)
        </button>
        <button
          type="button"
          disabled={bulkBuyerParse.isPending}
          onClick={() => bulkBuyerParse.mutate({ ids: bulkIds(), buyerParseEnabled: false })}
          className="rounded-lg border border-[#454b58] bg-[#1a1f28] px-3 py-2 text-sm text-[#c4c9d4] hover:bg-[#252a33] disabled:opacity-40"
        >
          Отключить парсинг (выбранные)
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[#252a33]">
        <table className="w-full min-w-[1580px] border-collapse text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-[#252a33] bg-[#13161c]">
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="whitespace-nowrap px-2 py-2 text-xs font-medium uppercase tracking-wide text-[#8b93a7]"
                    style={{ width: h.getSize() }}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-[#252a33]/60 hover:bg-white/[0.02] ${row.original.buyerParseEnabled === false ? "opacity-[0.72]" : ""}`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="px-2 py-2 align-top text-[#e8eaef]"
                    style={{ width: cell.column.getSize() }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {listQ.isLoading ? (
          <div className="p-6 text-[#8b93a7]">Загрузка…</div>
        ) : null}
        {listQ.isError ? (
          <div className="space-y-2 p-6 text-red-400">
            <p>{(listQ.error as Error).message}</p>
            {listQ.error instanceof ApiError && listQ.error.body != null && typeof listQ.error.body === "object" ? (
              <pre className="max-h-48 overflow-auto rounded-lg bg-black/35 p-3 text-xs text-red-200/90">
                {JSON.stringify(
                  "zod" in listQ.error.body ? (listQ.error.body as { zod: unknown }).zod : listQ.error.body,
                  null,
                  2,
                )}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
