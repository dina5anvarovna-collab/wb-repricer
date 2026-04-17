import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export function HistoryPage() {
  const q = useQuery({
    queryKey: ["history"],
    queryFn: () =>
      apiFetch<{
        cabinetUploads: Record<string, unknown>[];
        audit: Record<string, unknown>[];
      }>("/api/history?limit=80"),
  });
  if (q.isLoading) return <p className="text-[#8b93a7]">Загрузка…</p>;
  if (q.isError) return <p className="text-red-400">{(q.error as Error).message}</p>;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">История</h1>
      <section>
        <h2 className="mb-2 text-sm font-medium text-[#8b93a7]">Выгрузки в кабинет</h2>
        <div className="space-y-2">
          {q.data!.cabinetUploads.map((u, i) => (
            <div key={i} className="rounded-lg border border-[#252a33] bg-[#13161c] p-3 text-xs text-[#c4c9d4]">
              {String(u.createdAt)} · nm {String(u.nmId)} · {String(u.status)} ·{" "}
              {String(u.reasonCode ?? u.errorMessage ?? "")}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
