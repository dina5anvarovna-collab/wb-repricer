import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Eye, EyeOff } from "lucide-react";
import { apiFetch } from "../lib/api";

type RegionObs = {
  dest: string;
  label: string;
  clientPriceRub: number | null;
  basicPriceRub: number | null;
  ok: boolean;
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
  stock: number;
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

function MinPriceEdit({ item, onSaved }: { item: Item; onSaved: () => void }) {
  const initial = item.floorPrice != null && item.floorPrice > 1 ? String(Math.round(item.floorPrice)) : "";
  const [val, setVal] = useState<string>(initial);
  const [focused, setFocused] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Sync from server when prop changes (but not while user is typing)
  useEffect(() => {
    if (!focused) setVal(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const save = useMutation({
    mutationFn: async (n: number) =>
      apiFetch(`/api/products/${item.nmId}/min-rule`, {
        method: "PATCH",
        json: { minAllowedFinalPrice: n, controlEnabled: item.controlEnabled },
      }),
    onSuccess: () => {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved();
    },
  });

  const numeric = Number(val.replace(",", ".").trim());
  const valid = Number.isFinite(numeric) && numeric > 0;
  const changed = val.trim() !== initial;
  const submit = () => { if (valid && changed) save.mutate(numeric); };

  return (
    <div className="inline-flex items-center gap-1">
      <input
        type="number"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="мин ₽"
        className={`w-24 rounded border ${
          savedFlash ? "border-emerald-500/60" : changed ? "border-blue-500/60" : "border-[#323842]"
        } bg-[#0d0f14] px-2 py-1 text-right text-sm tabular-nums text-white placeholder:text-[#5a6170] focus:border-blue-500 focus:outline-none`}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!valid || !changed || save.isPending}
        className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-30"
      >
        OK
      </button>
    </div>
  );
}

function MonitorToggle({ item, onSaved }: { item: Item; onSaved: () => void }) {
  const save = useMutation({
    mutationFn: async (enabled: boolean) =>
      apiFetch(`/api/products/${item.nmId}/min-rule`, {
        method: "PATCH",
        json: {
          minAllowedFinalPrice: item.floorPrice ?? 1,
          controlEnabled: enabled,
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={item.controlEnabled}
        onChange={(e) => save.mutate(e.target.checked)}
        disabled={save.isPending}
        className="h-4 w-4 accent-blue-500"
      />
    </label>
  );
}

function StatusBadge({ item }: { item: Item }) {
  if (!item.controlEnabled) return null;
  const gap = breachGap(item.floorLog);
  if (gap != null) {
    return <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-300">−{Math.round(gap)} ₽</span>;
  }
  if (item.floorLog?.action === "observation_failed") {
    return <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">нет данных</span>;
  }
  if (item.floorLog) {
    return <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">ок</span>;
  }
  return null;
}

function StockCell({ stock }: { stock: number }) {
  const tone =
    stock === 0 ? "text-[#5a6170]"
    : stock <= 4 ? "text-amber-300"
    : "text-emerald-300";
  return <span className={`tabular-nums ${tone}`}>{stock}</span>;
}

type StockFilter = "all" | "inStock" | "outOfStock";
type StatusFilter = "all" | "monitored" | "unmonitored" | "breach";

export function CatalogPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const q = useQuery({
    queryKey: ["floor-region-prices"],
    queryFn: () => apiFetch<{ items: Item[] }>("/api/floor/region-prices"),
    refetchInterval: 60_000,
  });

  const allItems = q.data?.items ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allItems.filter((it) => {
      if (term) {
        const hay = `${it.title} ${it.nmId}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (stockFilter === "inStock" && it.stock <= 0) return false;
      if (stockFilter === "outOfStock" && it.stock > 0) return false;
      if (statusFilter === "monitored" && !it.controlEnabled) return false;
      if (statusFilter === "unmonitored" && it.controlEnabled) return false;
      if (statusFilter === "breach" && breachGap(it.floorLog) == null) return false;
      return true;
    });
  }, [allItems, search, stockFilter, statusFilter]);

  const stats = useMemo(() => ({
    total: allItems.length,
    monitored: allItems.filter((it) => it.controlEnabled).length,
    breach: allItems.filter((it) => breachGap(it.floorLog) != null).length,
    inStock: allItems.filter((it) => it.stock > 0).length,
    outOfStock: allItems.filter((it) => it.stock === 0).length,
  }), [allItems]);

  const refetch = () => void qc.invalidateQueries({ queryKey: ["floor-region-prices"] });

  // Bulk operations
  const bulkMutation = useMutation({
    mutationFn: ({ enabled }: { enabled: boolean }) =>
      apiFetch("/api/catalog/bulk-monitor", {
        method: "POST",
        json: { nmIds: Array.from(selected), enabled },
      }),
    onSuccess: () => {
      setSelected(new Set());
      refetch();
    },
  });

  function toggleSelect(nmId: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(nmId)) n.delete(nmId);
      else n.add(nmId);
      return n;
    });
  }
  function toggleSelectAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((it) => it.nmId)));
  }

  const allSelected = filtered.length > 0 && selected.size === filtered.length;
  const someSelected = selected.size > 0 && selected.size < filtered.length;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-white md:text-2xl">Каталог товаров</h1>
        <p className="mt-0.5 text-xs text-[#8b93a7] md:text-sm">
          Выберите товары для мониторинга и задайте минимальную цену
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5a6170]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию или nmId…"
            className="w-full rounded-lg border border-[#252a33] bg-[#0d0f14] py-2 pl-9 pr-3 text-sm text-white placeholder:text-[#5a6170] focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterGroup label="Остаток">
            <FilterChip active={stockFilter === "all"} onClick={() => setStockFilter("all")}>Все · {stats.total}</FilterChip>
            <FilterChip active={stockFilter === "inStock"} onClick={() => setStockFilter("inStock")}>С остатком · {stats.inStock}</FilterChip>
            <FilterChip active={stockFilter === "outOfStock"} onClick={() => setStockFilter("outOfStock")}>Без остатка · {stats.outOfStock}</FilterChip>
          </FilterGroup>
          <FilterGroup label="Мониторинг">
            <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>Все</FilterChip>
            <FilterChip active={statusFilter === "monitored"} onClick={() => setStatusFilter("monitored")}>Под защитой · {stats.monitored}</FilterChip>
            <FilterChip active={statusFilter === "unmonitored"} onClick={() => setStatusFilter("unmonitored")}>Не отслеживается</FilterChip>
            <FilterChip active={statusFilter === "breach"} onClick={() => setStatusFilter("breach")} tone="red">Ниже пола · {stats.breach}</FilterChip>
          </FilterGroup>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-100 backdrop-blur">
          <span className="font-medium">Выбрано: {selected.size}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => bulkMutation.mutate({ enabled: true })}
            disabled={bulkMutation.isPending}
            className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-40"
          >
            <Eye className="h-3.5 w-3.5" />
            Включить мониторинг
          </button>
          <button
            type="button"
            onClick={() => bulkMutation.mutate({ enabled: false })}
            disabled={bulkMutation.isPending}
            className="flex items-center gap-1 rounded border border-[#323842] px-3 py-1 text-xs text-[#c4c9d4] hover:bg-white/5 disabled:opacity-40"
          >
            <EyeOff className="h-3.5 w-3.5" />
            Отключить
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded border border-[#323842] px-3 py-1 text-xs text-[#8b93a7] hover:bg-white/5"
          >
            Сбросить
          </button>
        </div>
      ) : null}

      {q.isLoading ? (
        <p className="text-[#8b93a7]">Загрузка…</p>
      ) : q.isError ? (
        <p className="text-red-400">{(q.error as Error).message}</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-[#252a33] md:block">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[#252a33] bg-[#0d0f14] text-[10px] uppercase tracking-wide text-[#8b93a7]">
                  <th className="px-3 py-2 text-center font-medium">
                    <input
                      type="checkbox"
                      ref={(el) => { if (el) el.indeterminate = someSelected; }}
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 accent-blue-500"
                    />
                  </th>
                  <th className="px-4 py-2 font-medium">Товар</th>
                  <th className="px-3 py-2 text-right font-medium">Остаток</th>
                  <th className="px-3 py-2 text-right font-medium">Базовая</th>
                  <th className="px-3 py-2 text-right font-medium">Кошелёк</th>
                  <th className="px-3 py-2 text-right font-medium">Скидка WB</th>
                  <th className="px-3 py-2 text-right font-medium">Мин ₽</th>
                  <th className="px-3 py-2 text-center font-medium">Монитор</th>
                  <th className="px-3 py-2 text-center font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => {
                  const gap = breachGap(it.floorLog);
                  const isSelected = selected.has(it.nmId);
                  return (
                    <tr
                      key={it.nmId}
                      className={`border-b border-[#252a33]/60 ${gap != null ? "bg-red-500/[0.04]" : ""} ${isSelected ? "bg-blue-500/[0.05]" : ""}`}
                    >
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(it.nmId)}
                          className="h-4 w-4 accent-blue-500"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <div className="line-clamp-1 text-[#e8eaef]">{it.title || `nmId ${it.nmId}`}</div>
                        <div className="text-[10px] text-[#5a6170]">nmId {it.nmId}</div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <StockCell stock={it.stock} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="tabular-nums text-[#c4c9d4]">{fmt(it.basePrice)}</div>
                        <div className="text-[10px] tabular-nums text-[#8b93a7]">
                          {it.sellerDiscount ? `−${it.sellerDiscount}%` : " "}
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${gap != null ? "text-red-300" : it.floorLog?.minBuyerPriceRub != null ? "text-emerald-300" : "text-[#5a6170]"}`}>
                        {fmt(it.floorLog?.minBuyerPriceRub)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-200">
                        {it.floorLog?.kObserved != null ? fmtPct(it.floorLog.kObserved) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <MinPriceEdit item={it} onSaved={refetch} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <MonitorToggle item={it} onSaved={refetch} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <StatusBadge item={it} />
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-sm text-[#8b93a7]">
                      Ничего не найдено
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-2 md:hidden">
            {filtered.map((it) => {
              const gap = breachGap(it.floorLog);
              const isSelected = selected.has(it.nmId);
              return (
                <div
                  key={it.nmId}
                  className={`rounded-xl border ${gap != null ? "border-red-500/30" : "border-[#252a33]"} ${isSelected ? "bg-blue-500/[0.06]" : "bg-[#13161c]"} p-3`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(it.nmId)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-blue-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm text-white">{it.title || `nmId ${it.nmId}`}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[#5a6170]">
                        <span>nmId {it.nmId}</span>
                        <span>· остаток <StockCell stock={it.stock} /></span>
                        <StatusBadge item={it} />
                      </div>
                    </div>
                    <MonitorToggle item={it} onSaved={refetch} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-[10px] uppercase text-[#8b93a7]">Базовая</div>
                      <div className="tabular-nums text-[#c4c9d4]">
                        {fmt(it.basePrice)}
                        {it.sellerDiscount ? <span className="ml-1 text-[10px] text-[#8b93a7]">−{it.sellerDiscount}%</span> : null}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-[#8b93a7]">Кошелёк</div>
                      <div className={`tabular-nums ${gap != null ? "text-red-300" : "text-emerald-300"}`}>
                        {fmt(it.floorLog?.minBuyerPriceRub)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-[#8b93a7]">Скидка WB</div>
                      <div className="tabular-nums text-amber-200">
                        {it.floorLog?.kObserved != null ? fmtPct(it.floorLog.kObserved) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-[#8b93a7]">Мин ₽</div>
                      <div className="text-sm">
                        <MinPriceEdit item={it} onSaved={refetch} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#8b93a7]">Ничего не найдено</p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-[#252a33] bg-[#0d0f14] p-1">
      <span className="ml-1 text-[10px] uppercase text-[#5a6170]">{label}</span>
      <div className="flex flex-wrap gap-0.5">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "red";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
        active
          ? tone === "red"
            ? "bg-red-500/20 text-red-200"
            : "bg-blue-600/20 text-blue-200"
          : "text-[#8b93a7] hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
