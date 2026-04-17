import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type Row = {
  nmId: number;
  title: string;
  price: number | null;
  discountedPrice: number | null;
  sellerDiscountPercent: number | null;
  lastBuyerWalletRub: number | null;
  lastBuyerRegularRub: number | null;
  updatedAt: string;
};

export function PricesPage() {
  const q = useQuery({
    queryKey: ["prices-api"],
    queryFn: () => apiFetch<{ items: Row[] }>("/api/prices?limit=500"),
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
        <h1 className="text-2xl font-semibold text-white">Цены и скидки</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">
          Кабинет + последние значения мониторинга (итог покупателя), если были.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-[#252a33]">
        <table className="w-full min-w-[800px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[#252a33] bg-[#13161c] text-xs uppercase tracking-wide text-[#8b93a7]">
              <th className="px-3 py-2">nmId</th>
              <th className="px-3 py-2">Товар</th>
              <th className="px-3 py-2 text-right">Цена</th>
              <th className="px-3 py-2 text-right">Со скидкой</th>
              <th className="px-3 py-2 text-right">%</th>
              <th className="px-3 py-2 text-right">Кошелёк</th>
              <th className="px-3 py-2 text-right">Витрина</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.nmId} className="border-b border-[#252a33]/80 hover:bg-white/[0.02]">
                <td className="px-3 py-2 font-mono text-xs">{r.nmId}</td>
                <td className="max-w-[220px] px-3 py-2 text-[#e8eaef]">
                  <div className="line-clamp-2">{r.title}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.price != null ? `${Math.round(r.price)}` : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.discountedPrice != null ? `${Math.round(r.discountedPrice)}` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-[#8b93a7]">
                  {r.sellerDiscountPercent != null ? `${r.sellerDiscountPercent}%` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-200/90">
                  {r.lastBuyerWalletRub != null ? `${Math.round(r.lastBuyerWalletRub)}` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-[#c4c9d4]">
                  {r.lastBuyerRegularRub != null ? `${Math.round(r.lastBuyerRegularRub)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
