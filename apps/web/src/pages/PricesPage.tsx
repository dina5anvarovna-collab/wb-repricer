import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiFetch } from "../lib/api";

type RegionObs = {
  dest: string;
  label: string;
  clientPriceRub: number | null;
  basicPriceRub: number | null;
  ok: boolean;
  errorReason?: string;
};

type FloorLog = {
  action: string;
  kObserved: number | null;
  minBuyerPriceRub: number | null;
  floorPriceRub: number | null;
  oldBasePrice: number | null;
  newBasePrice: number | null;
  dryRun: boolean;
  updatedAt: string;
  regions: RegionObs[];
};

type Item = {
  nmId: number;
  title: string;
  basePrice: number | null;
  sellerDiscount: number | null;
  discountedPrice: number | null;
  floorPrice: number | null;
  controlEnabled: boolean;
  floorLog: FloorLog | null;
};

function fmt(v: number | null | undefined) {
  if (v == null) return "—";
  return `${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

function breachGap(log: FloorLog | null): number | null {
  if (!log || log.minBuyerPriceRub == null || log.floorPriceRub == null) return null;
  const gap = log.floorPriceRub - log.minBuyerPriceRub;
  return gap > 0 ? gap : null;
}

function StatusBadge({ log, controlEnabled }: { log: FloorLog | null; controlEnabled: boolean }) {
  if (!controlEnabled) {
    return <span className="rounded bg-[#252a33] px-1.5 py-0.5 text-[10px] uppercase text-[#8b93a7]">не контролируется</span>;
  }
  if (!log) {
    return <span className="rounded bg-[#252a33] px-1.5 py-0.5 text-[10px] uppercase text-[#8b93a7]">нет данных</span>;
  }
  const gap = breachGap(log);
  if (gap != null) {
    return (
      <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-300">
        ниже пола −{Math.round(gap)} ₽
      </span>
    );
  }
  if (log.action === "observation_failed") {
    return <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">нет парсинга</span>;
  }
  return <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">ок</span>;
}

function RegionsTable({ regions }: { regions: RegionObs[] }) {
  const active = regions.filter((r) => r.ok && r.clientPriceRub != null);
  if (active.length === 0) {
    return <p className="px-4 py-3 text-xs text-[#8b93a7]">Нет данных по регионам</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-3 md:grid-cols-4">
      {active.map((r) => (
        <div key={r.dest} className="rounded-lg border border-[#252a33] bg-[#0d0f14] px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-[#8b93a7]">{r.label}</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-emerald-300">
            {fmt(r.clientPriceRub)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProductRow({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const log = item.floorLog;
  const gap = breachGap(log);
  const hasRegions = (log?.regions?.filter((r) => r.ok && r.clientPriceRub != null).length ?? 0) > 0;

  return (
    <div className={`rounded-xl border ${gap != null ? "border-red-500/30" : "border-[#252a33]"} bg-[#13161c]`}>
      <button
        type="button"
        onClick={() => hasRegions && setOpen((v) => !v)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left ${hasRegions ? "cursor-pointer hover:bg-white/[0.02]" : "cursor-default"}`}
      >
        <span className="mt-1 shrink-0 text-[#5a6170]">
          {hasRegions ? (
            open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
          ) : (
            <span className="inline-block h-4 w-4" />
          )}
        </span>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-white line-clamp-1">{item.title || `nmId ${item.nmId}`}</span>
            <StatusBadge log={log} controlEnabled={item.controlEnabled} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Базовая" value={fmt(item.basePrice)} hint={item.sellerDiscount ? `−${item.sellerDiscount}%` : undefined} />
            <Metric label="Пол" value={fmt(item.floorPrice)} />
            <Metric
              label="Кошелёк (мин)"
              value={fmt(log?.minBuyerPriceRub)}
              tone={gap != null ? "red" : log?.minBuyerPriceRub != null ? "green" : undefined}
            />
            <Metric label="Скидка WB" value={log?.kObserved != null ? fmtPct(log.kObserved) : "—"} tone="amber" />
          </div>
        </div>
      </button>

      {open && hasRegions ? (
        <div className="border-t border-[#252a33]">
          <RegionsTable regions={log!.regions} />
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "red" | "green" | "amber" }) {
  const colorClass =
    tone === "red" ? "text-red-300"
    : tone === "green" ? "text-emerald-300"
    : tone === "amber" ? "text-amber-200"
    : "text-[#e8eaef]";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[#8b93a7]">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${colorClass}`}>
        {value}
        {hint ? <span className="ml-1 text-xs font-normal text-[#8b93a7]">{hint}</span> : null}
      </div>
    </div>
  );
}

export function PricesPage() {
  const q = useQuery({
    queryKey: ["floor-region-prices"],
    queryFn: () => apiFetch<{ items: Item[] }>("/api/floor/region-prices"),
    refetchInterval: 60_000,
  });

  const items = q.data?.items ?? [];
  const controlled = items.filter((it) => it.controlEnabled);
  const others = items.filter((it) => !it.controlEnabled);
  const breachCount = controlled.filter((it) => breachGap(it.floorLog) != null).length;
  const okCount = controlled.filter((it) => it.floorLog && breachGap(it.floorLog) == null && it.floorLog.action !== "observation_failed").length;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white md:text-2xl">Цены покупателя</h1>
          <p className="mt-0.5 text-xs text-[#8b93a7] md:text-sm">
            Цена с WB Кошельком по регионам и статус защиты пола
          </p>
        </div>
        <button
          type="button"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="flex items-center gap-1.5 rounded-lg border border-[#252a33] px-3 py-1.5 text-sm text-[#c4c9d4] hover:bg-white/5 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          Обновить
        </button>
      </div>

      {/* Summary chips */}
      {controlled.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Chip label="Под защитой" value={controlled.length} tone="blue" />
          <Chip label="В порядке" value={okCount} tone="green" />
          {breachCount > 0 ? <Chip label="Ниже пола" value={breachCount} tone="red" /> : null}
        </div>
      ) : null}

      {q.isLoading ? (
        <p className="text-[#8b93a7]">Загрузка…</p>
      ) : q.isError ? (
        <p className="text-red-400">{(q.error as Error).message}</p>
      ) : (
        <>
          {controlled.length > 0 ? (
            <div className="space-y-2">
              {controlled.map((item) => <ProductRow key={item.nmId} item={item} />)}
            </div>
          ) : null}

          {others.length > 0 ? (
            <details className="mt-4 rounded-xl border border-[#252a33] bg-[#13161c]/50">
              <summary className="cursor-pointer px-4 py-3 text-sm text-[#8b93a7] hover:text-white">
                Без контроля цены ({others.length})
              </summary>
              <div className="space-y-2 border-t border-[#252a33] p-2">
                {others.map((item) => <ProductRow key={item.nmId} item={item} />)}
              </div>
            </details>
          ) : null}

          {items.length === 0 ? <p className="text-center text-sm text-[#8b93a7]">Нет товаров</p> : null}
        </>
      )}
    </div>
  );
}

function Chip({ label, value, tone }: { label: string; value: number; tone: "blue" | "green" | "red" }) {
  const t =
    tone === "blue" ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
    : tone === "green" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
    : "border-red-500/30 bg-red-500/10 text-red-200";
  return (
    <div className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs ${t}`}>
      <span className="font-semibold tabular-nums">{value}</span>
      <span>{label}</span>
    </div>
  );
}
