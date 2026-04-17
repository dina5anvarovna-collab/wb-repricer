import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export function ConnectPage() {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const status = useQuery({
    queryKey: ["wb-status"],
    queryFn: () =>
      apiFetch<{
        seller: { configured: boolean; tokenValid: boolean | null };
        buyer: { active: boolean };
      }>("/api/wb/status"),
  });

  const save = useMutation({
    mutationFn: () => apiFetch("/api/wb/connect", { method: "POST", json: { token } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["wb-status"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const sync = useMutation({
    mutationFn: () => apiFetch<Record<string, unknown>>("/api/wb/sync", { method: "POST", json: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Подключение Wildberries</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">
          Токен категории «Цены и скидки», затем синхронизация каталога (цены + карточки Content API).
        </p>
      </div>
      <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5 space-y-4">
        <div className="text-sm text-[#c4c9d4]">
          Статус: продавец{" "}
          {status.data?.seller.configured
            ? status.data.seller.tokenValid
              ? "— токен ок"
              : "— токен не прошёл проверку"
            : "не настроен"}
          , покупатель {status.data?.buyer.active ? "активен" : "нет сессии"}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#8b93a7]">API-токен продавца</span>
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={3}
            className="rounded-lg border border-[#252a33] bg-[#0c0e12] px-3 py-2 text-white"
            placeholder="Вставьте токен…"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !token.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
          >
            Сохранить токен
          </button>
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="rounded-lg border border-[#252a33] px-4 py-2 text-sm text-white hover:bg-white/5 disabled:opacity-40"
          >
            Синхронизировать каталог
          </button>
        </div>
        {save.isError ? (
          <p className="text-sm text-red-400">{(save.error as Error).message}</p>
        ) : null}
        {sync.isSuccess ? (
          <pre className="overflow-auto rounded-lg bg-[#0c0e12] p-3 text-xs text-[#8b93a7]">
            {JSON.stringify(sync.data, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
