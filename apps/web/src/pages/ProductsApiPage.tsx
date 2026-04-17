import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type Item = {
  nmId: number;
  title: string;
  brand: string | null;
  vendorCode: string | null;
  price: number | null;
  discountedPrice: number | null;
  stocksTotal: number | null;
};

export function ProductsApiPage() {
  const q = useQuery({
    queryKey: ["products-unified"],
    queryFn: () => apiFetch<{ total: number; items: Item[] }>("/api/products?limit=200"),
  });
  if (q.isLoading) {
    return <p className="text-[#8b93a7]">Загрузка…</p>;
  }
  if (q.isError) {
    return <p className="text-red-400">{(q.error as Error).message}</p>;
  }
  const { total = 0, items = [] } = q.data ?? {};
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-white">Товары (API)</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">Нормализованный снимок из БД. Всего в каталоге: {total}</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-[#252a33]">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[#252a33] bg-[#13161c] text-xs uppercase tracking-wide text-[#8b93a7]">
              <th className="px-3 py-2">nmId</th>
              <th className="px-3 py-2">Название</th>
              <th className="px-3 py-2 text-right">Цена</th>
              <th className="px-3 py-2 text-right">Со скидкой</th>
              <th className="px-3 py-2 text-right">Остаток</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.nmId} className="border-b border-[#252a33]/80 hover:bg-white/[0.02]">
                <td className="px-3 py-2 font-mono text-xs">{r.nmId}</td>
                <td className="max-w-[300px] px-3 py-2">
                  <div className="text-[#e8eaef]">{r.title}</div>
                  <div className="text-xs text-[#8b93a7]">
                    {r.brand ?? "—"} · {r.vendorCode ?? "—"}
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.price != null ? Math.round(r.price) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.discountedPrice != null ? Math.round(r.discountedPrice) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.stocksTotal ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
