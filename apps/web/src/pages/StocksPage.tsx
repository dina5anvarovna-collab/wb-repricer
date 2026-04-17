import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type Row = {
  nmId: number;
  title: string;
  vendorCode: string | null;
  brand: string | null;
  stocksTotal: number;
  updatedAt: string;
};

export function StocksPage() {
  const q = useQuery({
    queryKey: ["stocks"],
    queryFn: () => apiFetch<{ items: Row[] }>("/api/stocks?limit=500"),
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
      <div>
        <h1 className="text-2xl font-semibold text-white">Остатки</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">Данные кабинета после синхронизации (агрегат «всего»).</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-[#252a33]">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[#252a33] bg-[#13161c] text-xs uppercase tracking-wide text-[#8b93a7]">
              <th className="px-3 py-2">nmId</th>
              <th className="px-3 py-2">Товар</th>
              <th className="px-3 py-2">Бренд</th>
              <th className="px-3 py-2 text-right">Остаток</th>
              <th className="px-3 py-2">Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.nmId} className="border-b border-[#252a33]/80 hover:bg-white/[0.02]">
                <td className="px-3 py-2 font-mono text-xs text-[#c4c9d4]">{r.nmId}</td>
                <td className="max-w-[280px] px-3 py-2 text-[#e8eaef]">
                  <div className="line-clamp-2">{r.title}</div>
                  {r.vendorCode ? (
                    <div className="text-xs text-[#8b93a7]">{r.vendorCode}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-[#8b93a7]">{r.brand ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-white">{r.stocksTotal}</td>
                <td className="px-3 py-2 text-xs text-[#8b93a7]">
                  {new Date(r.updatedAt).toLocaleString("ru-RU")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
