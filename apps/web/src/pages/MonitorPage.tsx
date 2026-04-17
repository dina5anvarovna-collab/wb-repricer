import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export function MonitorPage() {
  const run = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; jobId?: string; processed?: number }>("/api/monitor/run", {
        method: "POST",
        json: { maxProducts: 80 },
      }),
  });
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold text-white">Мониторинг</h1>
      <p className="text-sm text-[#8b93a7]">
        Сбор цен с витрины (Playwright + профиль покупателя) и запись снимков в БД. Нужна активная{" "}
        <strong className="text-[#c4c9d4]">сессия покупателя</strong> (раздел «Настройки» → блок WB
        Покупатель).
      </p>
      <p className="text-xs text-[#8b93a7]">
        Conflict: уже идёт другой прогон мониторинга — дождитесь «monitor job done» в терминале. В development
        плановый мониторинг по умолчанию выключен; при 409 проверьте второй запущенный сервер или зависший процесс.
      </p>
      <button
        type="button"
        disabled={run.isPending}
        onClick={() => run.mutate()}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
      >
        Запустить мониторинг
      </button>
      {run.data ? (
        <pre className="rounded-lg bg-[#13161c] p-4 text-xs text-[#c4c9d4]">
          {JSON.stringify(run.data, null, 2)}
        </pre>
      ) : null}
      {run.isError ? <p className="text-red-400">{(run.error as Error).message}</p> : null}
    </div>
  );
}
