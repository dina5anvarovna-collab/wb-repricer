import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type Region = { dest: string; name: string; id?: string };

export function RegionsPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  /** Без этого refetch настроек сбрасывал выбор до сохранения — «Сохранить» казалось неактивным/бесполезным */
  const [touched, setTouched] = useState(false);

  const regions = useQuery({
    queryKey: ["regions"],
    queryFn: () => apiFetch<{ items: Region[] }>("/api/regions"),
  });

  const settings = useQuery({
    queryKey: ["app-settings"],
    queryFn: () =>
      apiFetch<{ SELECTED_REGION_DESTS: string[] }>("/api/app/settings"),
  });

  useEffect(() => {
    if (settings.data?.SELECTED_REGION_DESTS !== undefined && !touched) {
      setSelected([...settings.data.SELECTED_REGION_DESTS]);
    }
  }, [settings.data?.SELECTED_REGION_DESTS, touched]);

  const dirty = useMemo(() => {
    const a = [...(settings.data?.SELECTED_REGION_DESTS ?? [])].sort().join("\0");
    const b = [...selected].sort().join("\0");
    return a !== b;
  }, [settings.data?.SELECTED_REGION_DESTS, selected]);

  const save = useMutation({
    mutationFn: () =>
      apiFetch("/api/app/settings", {
        method: "PATCH",
        json: { selectedRegionDests: selected },
      }),
    onSuccess: () => {
      setTouched(false);
      void qc.invalidateQueries({ queryKey: ["app-settings"] });
      void qc.invalidateQueries({ queryKey: ["catalog"] });
    },
  });

  function toggle(dest: string) {
    setTouched(true);
    setSelected((s) => (s.includes(dest) ? s.filter((x) => x !== dest) : [...s, dest]));
  }

  if (regions.isLoading || settings.isLoading) return <p className="text-[#8b93a7]">Загрузка…</p>;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold text-white">Регионы витрины</h1>
      <p className="text-sm text-[#8b93a7]">
        Города/склады WB для мониторинга (цена кошелька и витрины зависят от региона). Сохраните выбор, затем
        запустите мониторинг.
      </p>
      <div className="max-h-[50vh] space-y-1 overflow-y-auto rounded-xl border border-[#252a33] bg-[#13161c] p-3">
        {(regions.data?.items ?? []).map((r) => (
          <label key={r.dest} className="flex cursor-pointer items-center gap-2 py-1 text-sm text-[#e8eaef]">
            <input type="checkbox" checked={selected.includes(r.dest)} onChange={() => toggle(r.dest)} />
            <span className="font-medium">{r.name || r.dest}</span>
            <span className="text-xs text-[#5c6578]" title="Технический код WB (dest)">
              {r.dest}
            </span>
          </label>
        ))}
      </div>
      {save.isError ? (
        <p className="text-sm text-red-400">{(save.error as Error).message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {save.isPending ? "Сохранение…" : "Сохранить регионы"}
        </button>
        {!dirty ? (
          <span className="text-xs text-[#8b93a7]">Измените галочки, чтобы включить сохранение</span>
        ) : null}
      </div>
    </div>
  );
}
