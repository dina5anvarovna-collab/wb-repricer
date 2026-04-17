import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export function RulesPage() {
  const dry = useMutation({
    mutationFn: () =>
      apiFetch("/api/jobs/enforce-prices", {
        method: "POST",
        json: { dryRun: true, maxProducts: 50 },
      }),
  });
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold text-white">Правила минимальной цены</h1>
      <p className="text-sm text-[#8b93a7]">
        Минимальную итоговую цену можно задать в карточке товара (API), импортом CSV или через каталог. Удержание
        использует цену WB Кошелька с витрины (не подменяется обычной ценой).
      </p>
      <button
        type="button"
        onClick={() => dry.mutate()}
        disabled={dry.isPending}
        className="rounded-lg bg-amber-600/90 px-4 py-2 text-sm text-white"
      >
        Прогон удержания (dry-run)
      </button>
      {dry.data ? (
        <pre className="text-xs text-[#c4c9d4]">{JSON.stringify(dry.data, null, 2)}</pre>
      ) : null}
    </div>
  );
}
