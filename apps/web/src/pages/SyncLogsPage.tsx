import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type LogRow = {
  id: string;
  scope: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  errorMessage: string | null;
};

export function SyncLogsPage() {
  const q = useQuery({
    queryKey: ["sync-logs"],
    queryFn: () => apiFetch<{ items: LogRow[] }>("/api/logs?limit=80"),
  });
  if (q.isLoading) {
    return <p className="text-[#8b93a7]">Загрузка…</p>;
  }
  if (q.isError) {
    return <p className="text-red-400">{(q.error as Error).message}</p>;
  }
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-white">Журнал синхронизаций</h1>
      <div className="overflow-x-auto rounded-xl border border-[#252a33]">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[#252a33] bg-[#13161c] text-xs uppercase text-[#8b93a7]">
              <th className="px-3 py-2">Область</th>
              <th className="px-3 py-2">Статус</th>
              <th className="px-3 py-2">Начало</th>
              <th className="px-3 py-2">Конец</th>
              <th className="px-3 py-2">Сообщение</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-b border-[#252a33]/80">
                <td className="px-3 py-2 text-[#c4c9d4]">{r.scope}</td>
                <td className="px-3 py-2">
                  <span
                    className={
                      r.status === "done"
                        ? "text-emerald-300"
                        : r.status === "failed"
                          ? "text-red-300"
                          : "text-amber-200"
                    }
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-[#8b93a7]">
                  {new Date(r.startedAt).toLocaleString("ru-RU")}
                </td>
                <td className="px-3 py-2 text-xs text-[#8b93a7]">
                  {r.finishedAt ? new Date(r.finishedAt).toLocaleString("ru-RU") : "—"}
                </td>
                <td className="max-w-md px-3 py-2 text-xs text-[#9aa3b5]">
                  {r.errorMessage ?? r.message ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
