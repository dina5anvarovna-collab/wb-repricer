import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2, Pencil, Star, RefreshCw } from "lucide-react";
import { apiFetch } from "../lib/api";

type Cabinet = {
  id: string;
  name: string;
  tokenLast4: string;
  isActive: boolean;
  productsCount: number;
  createdAt: string;
};

type Region = { dest: string; name: string };

export function SettingsPage() {
  const qc = useQueryClient();

  // ─── Cabinets ────────────────────────────────────────────────────────────────
  const cabinetsQ = useQuery({
    queryKey: ["cabinets"],
    queryFn: () => apiFetch<{ items: Cabinet[] }>("/api/cabinets"),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newToken, setNewToken] = useState("");

  const addCabinet = useMutation({
    mutationFn: () =>
      apiFetch("/api/cabinets", {
        method: "POST",
        json: { name: newName || "Магазин", token: newToken.trim() },
      }),
    onSuccess: () => {
      setAddOpen(false);
      setNewName("");
      setNewToken("");
      void qc.invalidateQueries({ queryKey: ["cabinets"] });
      void qc.invalidateQueries({ queryKey: ["wb-status"] });
    },
  });

  const activateCabinet = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cabinets/${id}/activate`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cabinets"] });
      void qc.invalidateQueries({ queryKey: ["floor-region-prices"] });
    },
  });

  const deleteCabinet = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cabinets/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["cabinets"] }),
  });

  const renameCabinet = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch(`/api/cabinets/${id}`, { method: "PATCH", json: { name } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["cabinets"] }),
  });

  const syncCatalog = useMutation({
    mutationFn: () => apiFetch("/api/wb/sync", { method: "POST", json: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["floor-region-prices"] });
      void qc.invalidateQueries({ queryKey: ["cabinets"] });
    },
  });

  // ─── Regions ─────────────────────────────────────────────────────────────────
  const regionsQ = useQuery({
    queryKey: ["regions"],
    queryFn: () => apiFetch<{ items: Region[] }>("/api/regions"),
  });

  const settingsQ = useQuery({
    queryKey: ["app-settings"],
    queryFn: () => apiFetch<{ SELECTED_REGION_DESTS: string[] }>("/api/app/settings"),
  });

  const [selectedRegions, setSelectedRegions] = useState<string[] | null>(null);
  useEffect(() => {
    if (settingsQ.data?.SELECTED_REGION_DESTS && selectedRegions == null) {
      setSelectedRegions([...settingsQ.data.SELECTED_REGION_DESTS]);
    }
  }, [settingsQ.data?.SELECTED_REGION_DESTS, selectedRegions]);

  const regionsDirty = useMemo(() => {
    if (selectedRegions == null) return false;
    const a = [...(settingsQ.data?.SELECTED_REGION_DESTS ?? [])].sort().join(",");
    const b = [...selectedRegions].sort().join(",");
    return a !== b;
  }, [settingsQ.data?.SELECTED_REGION_DESTS, selectedRegions]);

  const saveRegions = useMutation({
    mutationFn: () =>
      apiFetch("/api/app/settings", {
        method: "PATCH",
        json: { selectedRegionDests: selectedRegions ?? [] },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["app-settings"] });
      void qc.invalidateQueries({ queryKey: ["floor-region-prices"] });
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white md:text-2xl">Настройки</h1>
        <p className="mt-0.5 text-xs text-[#8b93a7] md:text-sm">
          Магазины WB, регионы мониторинга
        </p>
      </div>

      {/* ─── Cabinets section ──────────────────────────────────── */}
      <section className="rounded-xl border border-[#252a33] bg-[#13161c]">
        <div className="flex items-center justify-between border-b border-[#252a33] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Магазины Wildberries</h2>
            <p className="text-xs text-[#8b93a7]">Активный магазин используется для защиты пола</p>
          </div>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" />
            Добавить
          </button>
        </div>

        <div className="divide-y divide-[#252a33]">
          {cabinetsQ.isLoading ? (
            <p className="px-4 py-4 text-sm text-[#8b93a7]">Загрузка…</p>
          ) : (cabinetsQ.data?.items ?? []).length === 0 ? (
            <p className="px-4 py-4 text-sm text-[#8b93a7]">Нет подключённых магазинов. Добавьте первый.</p>
          ) : (
            (cabinetsQ.data?.items ?? []).map((c) => (
              <CabinetRow
                key={c.id}
                cabinet={c}
                onActivate={() => activateCabinet.mutate(c.id)}
                onDelete={() => {
                  if (confirm(`Удалить магазин «${c.name}» и все его товары?`)) deleteCabinet.mutate(c.id);
                }}
                onRename={(name) => renameCabinet.mutate({ id: c.id, name })}
                busy={activateCabinet.isPending || deleteCabinet.isPending}
              />
            ))
          )}
        </div>

        {(cabinetsQ.data?.items ?? []).some((c) => c.isActive) ? (
          <div className="flex items-center justify-between border-t border-[#252a33] px-4 py-3">
            <span className="text-xs text-[#8b93a7]">
              Синхронизировать каталог активного магазина (загрузка товаров через WB API)
            </span>
            <button
              type="button"
              onClick={() => syncCatalog.mutate()}
              disabled={syncCatalog.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-[#323842] px-3 py-1.5 text-sm text-[#c4c9d4] hover:bg-white/5 disabled:opacity-40"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncCatalog.isPending ? "animate-spin" : ""}`} />
              Синхронизировать
            </button>
          </div>
        ) : null}

        {syncCatalog.isSuccess ? (
          <div className="mx-4 mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            Каталог обновлён
          </div>
        ) : null}
        {syncCatalog.isError ? (
          <div className="mx-4 mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {(syncCatalog.error as Error).message}
          </div>
        ) : null}
      </section>

      {/* ─── Add cabinet dialog ─────────────────────────────────── */}
      {addOpen ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" onClick={() => setAddOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-[#252a33] bg-[#13161c] p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">Подключить магазин WB</h3>
            <p className="mt-1 text-xs text-[#8b93a7]">
              API-токен категории «Цены и скидки» из ЛК продавца
            </p>
            <label className="mt-4 flex flex-col gap-1 text-xs">
              <span className="text-[#8b93a7]">Название магазина</span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Например: Основной магазин"
                className="rounded-lg border border-[#323842] bg-[#0d0f14] px-3 py-2 text-sm text-white placeholder:text-[#5a6170] focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="mt-3 flex flex-col gap-1 text-xs">
              <span className="text-[#8b93a7]">API-токен</span>
              <textarea
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                rows={3}
                placeholder="Вставьте токен…"
                className="rounded-lg border border-[#323842] bg-[#0d0f14] px-3 py-2 text-sm text-white placeholder:text-[#5a6170] focus:border-blue-500 focus:outline-none"
              />
            </label>
            {addCabinet.isError ? (
              <p className="mt-3 text-sm text-red-300">{(addCabinet.error as Error).message}</p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="rounded-lg border border-[#323842] px-3 py-2 text-sm text-[#c4c9d4] hover:bg-white/5"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => addCabinet.mutate()}
                disabled={!newToken.trim() || addCabinet.isPending}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
              >
                {addCabinet.isPending ? "Сохранение…" : "Подключить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ─── Regions section ────────────────────────────────────── */}
      <section className="rounded-xl border border-[#252a33] bg-[#13161c]">
        <div className="border-b border-[#252a33] px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Регионы мониторинга</h2>
          <p className="text-xs text-[#8b93a7]">
            Города/склады, по которым проверяется цена с WB Кошельком (worst-case по регионам = цена для защиты пола)
          </p>
        </div>

        {regionsQ.isLoading || settingsQ.isLoading ? (
          <p className="px-4 py-4 text-sm text-[#8b93a7]">Загрузка…</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-1 p-3 sm:grid-cols-2">
              {(regionsQ.data?.items ?? []).map((r) => {
                const checked = selectedRegions?.includes(r.dest) ?? false;
                return (
                  <label
                    key={r.dest}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                      checked ? "bg-blue-600/10 text-blue-100" : "text-[#c4c9d4] hover:bg-white/5"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedRegions((s) => {
                          const cur = s ?? [];
                          return cur.includes(r.dest) ? cur.filter((x) => x !== r.dest) : [...cur, r.dest];
                        })
                      }
                      className="h-4 w-4 accent-blue-500"
                    />
                    <span>{r.name || r.dest}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-[#252a33] px-4 py-3">
              <span className="text-xs text-[#8b93a7]">
                {regionsDirty ? "Есть несохранённые изменения" : "Регионы сохранены"}
              </span>
              <button
                type="button"
                onClick={() => saveRegions.mutate()}
                disabled={!regionsDirty || saveRegions.isPending}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
              >
                {saveRegions.isPending ? "Сохранение…" : "Сохранить"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function CabinetRow({
  cabinet,
  onActivate,
  onDelete,
  onRename,
  busy,
}: {
  cabinet: Cabinet;
  onActivate: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(cabinet.name);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${cabinet.isActive ? "bg-blue-500/20 text-blue-300" : "bg-[#252a33] text-[#5a6170]"}`}>
        <Star className={`h-3.5 w-3.5 ${cabinet.isActive ? "fill-current" : ""}`} />
      </div>

      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameDraft.trim()) {
                onRename(nameDraft.trim());
                setEditing(false);
              }
              if (e.key === "Escape") {
                setNameDraft(cabinet.name);
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (nameDraft.trim() && nameDraft.trim() !== cabinet.name) onRename(nameDraft.trim());
              setEditing(false);
            }}
            autoFocus
            className="w-full rounded border border-[#323842] bg-[#0d0f14] px-2 py-1 text-sm text-white focus:border-blue-500 focus:outline-none"
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-medium text-white">{cabinet.name}</span>
            <button type="button" onClick={() => setEditing(true)} className="text-[#5a6170] hover:text-white">
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="text-[10px] text-[#5a6170]">
          токен …{cabinet.tokenLast4} · товаров {cabinet.productsCount}
          {cabinet.isActive ? " · активный" : ""}
        </div>
      </div>

      {!cabinet.isActive ? (
        <button
          type="button"
          onClick={onActivate}
          disabled={busy}
          className="flex items-center gap-1 rounded border border-[#323842] px-2.5 py-1 text-xs text-[#c4c9d4] hover:bg-white/5 disabled:opacity-40"
        >
          <Check className="h-3 w-3" />
          Сделать активным
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="rounded border border-[#3a2a2e] px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
        title="Удалить кабинет"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
