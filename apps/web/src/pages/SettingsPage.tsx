import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type SettingsStatus = {
  buyer: {
    active: boolean;
    profileDir: string;
    lastSuccessAt: string | null;
    lastDomSuccessAt: string | null;
    status: string;
  };
  parsePolicy?: {
    publicFirst: boolean;
    walletParseMode: string;
    buyerVerifyMode: string;
  };
  publicParsing?: {
    buyerAuthDisabled: boolean;
    publicOnly: boolean;
    walletParseMode: string;
    walletDetailsMode: string;
  };
};

type BuyerLoginStart = {
  sessionId: string;
  profileDir: string;
  instruction: string;
  cliCommand: string;
  cliPath?: string;
  cliExists?: boolean;
  browser?: string;
  hints?: string[];
  headedLoginAvailable?: boolean;
  autoLoginWindowSpawned?: boolean;
  autoLoginWindowAttempted?: boolean;
};

export function SettingsPage() {
  const qc = useQueryClient();
  const [loginPayload, setLoginPayload] = useState<BuyerLoginStart | null>(null);

  const q = useQuery({
    queryKey: ["app-settings"],
    queryFn: () =>
      apiFetch<{
        GLOBAL_PAUSE: string;
        EMERGENCY_STOP: string;
        MONITOR_INTERVAL_HOURS: number;
      }>("/api/app/settings"),
  });

  const statusQ = useQuery({
    queryKey: ["settings-status"],
    queryFn: () => apiFetch<SettingsStatus>("/api/settings/status"),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/app/settings", { method: "PATCH", json: body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["app-settings"] }),
  });

  const buyerLoginStart = useMutation({
    mutationFn: () =>
      apiFetch<BuyerLoginStart>("/api/settings/buyer-session/login/start", { method: "POST" }),
    onSuccess: (data) => setLoginPayload(data),
  });

  const buyerLoginFinish = useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch("/api/settings/buyer-session/login/finish", {
        method: "POST",
        json: { sessionId },
      }),
    onSuccess: () => {
      setLoginPayload(null);
      void qc.invalidateQueries({ queryKey: ["settings-status"] });
    },
  });

  if (q.isLoading) return <p className="text-[#8b93a7]">Загрузка…</p>;
  const s = q.data!;
  const buyer = statusQ.data?.buyer;
  const buyerAuthOff = statusQ.data?.publicParsing?.buyerAuthDisabled ?? false;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold text-white">Настройки</h1>

      <div className="space-y-4 rounded-xl border border-[#252a33] bg-[#13161c] p-5">
        <h2 className="text-lg font-medium text-white">WB Покупатель (витрина / Кошелёк)</h2>
        <p className="text-sm text-[#8b93a7]">
          {buyerAuthOff ? (
            <>
              Включён режим только публичного парсинга (без buyer-login). Карточка и popup детализации; ephemeral-профиль
              браузера без сохранённых cookies.
            </>
          ) : (
            <>
              По умолчанию сервер использует <strong className="text-[#c4c9d4]">public-first</strong>: публичная карточка
              и popup детализации; buyer-login и импорт cookies — опциональный fallback. Сессия покупателя не обязательна
              для мониторинга.
            </>
          )}
        </p>
        {statusQ.data?.parsePolicy ? (
          <p className="text-xs text-[#8b93a7]">
            .env: REPRICER_WALLET_PARSE_MODE={statusQ.data.parsePolicy.walletParseMode}, buyer verify=
            {statusQ.data.parsePolicy.buyerVerifyMode}, public-first:{" "}
            <span className={statusQ.data.parsePolicy.publicFirst ? "text-emerald-300" : "text-amber-200"}>
              {statusQ.data.parsePolicy.publicFirst ? "да" : "нет"}
            </span>
          </p>
        ) : null}
        {buyerAuthOff ? (
          <p className="rounded-lg border border-[#252a33] bg-[#0c0e12] px-3 py-2 text-sm text-[#c4c9d4]">
            Buyer-login отключён конфигурацией. Чтобы вернуть импорт профиля и CLI, задайте{" "}
            <code className="text-[#8b93a7]">REPRICER_DISABLE_BUYER_AUTH=false</code> и перезапустите сервер.
          </p>
        ) : statusQ.isLoading ? (
          <p className="text-sm text-[#8b93a7]">Проверка сессии…</p>
        ) : buyer?.active ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
            Сессия активна. Профиль: <code className="text-xs text-emerald-200">{buyer.profileDir}</code>
            {buyer.lastDomSuccessAt ? (
              <span className="mt-1 block text-xs text-emerald-200/90">
                Последний успешный DOM: {buyer.lastDomSuccessAt}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            Активной сессии нет (status: {buyer?.status ?? "—"}). Запустите вход по шагам ниже на{" "}
            <strong>той же машине</strong>, где крутится сервер repricer (не в браузере на телефоне).
          </div>
        )}

        {!buyerAuthOff ? (
          <>
            <p className="text-xs text-[#8b93a7]">
              Кнопка ниже не «рисует» вход внутри вкладки: на этой же машине должен запуститься настоящий Chromium/Chrome
              (на macOS он стартует сам в фоне; иначе — скопируйте команду в Terminal).
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={buyerLoginStart.isPending}
                onClick={() => buyerLoginStart.mutate()}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
              >
                {buyerLoginStart.isPending ? "Готовим команду…" : "1. Получить команду для входа в WB"}
              </button>
              {loginPayload ? (
                <button
                  type="button"
                  disabled={buyerLoginFinish.isPending}
                  onClick={() => buyerLoginFinish.mutate(loginPayload.sessionId)}
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  {buyerLoginFinish.isPending ? "Сохранение…" : "2. Подтвердить вход (после логина в браузере)"}
                </button>
              ) : null}
            </div>

            {buyerLoginStart.isError ? (
              <p className="text-sm text-red-400">{(buyerLoginStart.error as Error).message}</p>
            ) : null}
            {buyerLoginFinish.isError ? (
              <p className="text-sm text-red-400">{(buyerLoginFinish.error as Error).message}</p>
            ) : null}

            {loginPayload?.hints && loginPayload.hints.length > 0 ? (
              <ul className="list-inside list-disc space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                {loginPayload.hints.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            ) : null}

            {loginPayload?.autoLoginWindowSpawned ? (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
                Запущено окно браузера для входа (процесс отделён от вкладки с настройками). Проверьте Dock / Cmd+Tab.
                После входа в WB нажмите «Подтвердить вход».
              </p>
            ) : null}
            {loginPayload ? (
              <div className="space-y-2 rounded-lg border border-[#252a33] bg-[#0c0e12] p-3 text-sm text-[#c4c9d4]">
                <p className="text-[#8b93a7]">{loginPayload.instruction}</p>
                <p className="text-xs text-[#8b93a7]">
                  sessionId: {loginPayload.sessionId}
                  {loginPayload.browser ? ` · браузер: ${loginPayload.browser}` : null}
                  {loginPayload.cliExists === false ? (
                    <span className="ml-2 text-red-300">CLI не собран — см. подсказки выше</span>
                  ) : null}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <pre className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 text-xs">
                    {loginPayload.cliCommand}
                  </pre>
                  <button
                    type="button"
                    className="shrink-0 rounded border border-[#252a33] px-2 py-1 text-xs text-[#c4c9d4] hover:bg-white/5"
                    onClick={() => void navigator.clipboard.writeText(loginPayload.cliCommand)}
                  >
                    Копировать
                  </button>
                </div>
                <p className="text-xs text-[#8b93a7]">
                  Если браузер не стартует: в корне проекта один раз{" "}
                  <code className="text-[#c4c9d4]">npm run build && npx playwright install chromium</code>, затем снова
                  «Получить команду». Для Chrome задайте в <code className="text-[#c4c9d4]">.env</code>:{" "}
                  <code className="text-[#c4c9d4]">REPRICER_DOM_BROWSER=chrome</code>.
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="space-y-4 rounded-xl border border-[#252a33] bg-[#13161c] p-5">
        <label className="flex items-center gap-2 text-sm text-[#e8eaef]">
          <input
            type="checkbox"
            checked={s.GLOBAL_PAUSE === "true" || s.GLOBAL_PAUSE === "1"}
            onChange={(e) => patch.mutate({ GLOBAL_PAUSE: e.target.checked })}
          />
          Глобальная пауза защиты
        </label>
        <label className="flex items-center gap-2 text-sm text-[#e8eaef]">
          <input
            type="checkbox"
            checked={s.EMERGENCY_STOP === "true" || s.EMERGENCY_STOP === "1"}
            onChange={(e) => patch.mutate({ EMERGENCY_STOP: e.target.checked })}
          />
          Аварийный стоп
        </label>
        <div className="text-sm text-[#8b93a7]">
          Интервал мониторинга (часы): <strong className="text-white">{s.MONITOR_INTERVAL_HOURS}</strong> — меняется через API PATCH
          monitorIntervalHours
        </div>
      </div>
    </div>
  );
}
