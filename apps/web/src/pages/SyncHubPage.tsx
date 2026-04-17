import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export function SyncHubPage() {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    void qc.invalidateQueries({ queryKey: ["catalog"] });
    void qc.invalidateQueries({ queryKey: ["sync-logs"] });
  };

  const all = useMutation({
    mutationFn: () => apiFetch<Record<string, unknown>>("/api/sync/all", { method: "POST" }),
    onSuccess: inv,
  });
  const stocks = useMutation({
    mutationFn: () => apiFetch<Record<string, unknown>>("/api/sync/stocks", { method: "POST" }),
    onSuccess: inv,
  });
  const prices = useMutation({
    mutationFn: () => apiFetch<Record<string, unknown>>("/api/sync/prices", { method: "POST" }),
    onSuccess: inv,
  });

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Синхронизация</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">
          Каталог и снимки цен/остатков через Seller API (токен). Журнал: раздел «Логи синхронизаций».
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={all.isPending}
          onClick={() => all.mutate()}
          className="rounded-xl bg-blue-600/90 px-4 py-3 text-left text-sm text-white hover:bg-blue-600 disabled:opacity-40"
        >
          <div className="font-medium">Полная синхронизация</div>
          <div className="text-xs text-blue-100/80">Каталог WB + история цен и остатков в БД</div>
        </button>
        <button
          type="button"
          disabled={stocks.isPending}
          onClick={() => stocks.mutate()}
          className="rounded-xl border border-[#252a33] bg-[#13161c] px-4 py-3 text-left text-sm text-[#e8eaef] hover:bg-[#1a1e26] disabled:opacity-40"
        >
          <div className="font-medium">Только остатки</div>
          <div className="text-xs text-[#8b93a7]">Обновить каталог и снимок остатков</div>
        </button>
        <button
          type="button"
          disabled={prices.isPending}
          onClick={() => prices.mutate()}
          className="rounded-xl border border-[#252a33] bg-[#13161c] px-4 py-3 text-left text-sm text-[#e8eaef] hover:bg-[#1a1e26] disabled:opacity-40"
        >
          <div className="font-medium">Только цены и скидки</div>
          <div className="text-xs text-[#8b93a7]">Обновить каталог и снимок цен</div>
        </button>
      </div>
      {[all, stocks, prices].map((m, i) =>
        m.data ? (
          <pre
            key={i}
            className="overflow-x-auto rounded-lg border border-[#252a33] bg-black/30 p-3 text-xs text-[#9aa3b5]"
          >
            {JSON.stringify(m.data, null, 2)}
          </pre>
        ) : null,
      )}
      {all.error ? (
        <p className="text-sm text-red-300">{(all.error as Error).message}</p>
      ) : null}
    </div>
  );
}
