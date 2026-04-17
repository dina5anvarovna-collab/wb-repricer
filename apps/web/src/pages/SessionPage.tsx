import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../lib/api";

type ParsePolicy = {
  publicFirst: boolean;
  walletParseMode: string;
  buyerVerifyMode: string;
};

type AuthStatus = {
  sellerApi: { status: string; lastValidatedAt: string | null; lastError: string | null };
  buyerBrowser: {
    status: string;
    profileDir: string;
    storageStatePath: string;
    cookieFileExists: boolean;
    lastRefreshAt: string | null;
  };
  checks: { sellerTokenAlive: boolean; buyerCookieProbe: boolean; hasCookieFile: boolean };
  needsBuyerLogin: boolean;
  message: string | null;
  parsePolicy?: ParsePolicy;
};

export function SessionPage() {
  const qc = useQueryClient();
  const [probeNmId, setProbeNmId] = useState("");
  const q = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => apiFetch<AuthStatus>("/api/auth/status"),
  });

  const checkM = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>("/api/auth/check", { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["auth-status"] }),
  });

  const refreshM = useMutation({
    mutationFn: (headed: boolean) =>
      apiFetch<{ ok: boolean; message: string }>("/api/auth/refresh", {
        method: "POST",
        json: { headed },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["auth-status"] }),
  });

  const loginStartM = useMutation({
    mutationFn: () =>
      apiFetch<{
        instruction: string;
        cliCommand: string;
        profileDir: string;
        alternative?: string;
        headedLoginAvailable?: boolean;
        headedLoginNote?: string | null;
      }>("/api/auth/login/start", { method: "POST" }),
  });

  const importStorageM = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("Файл не является валидным JSON (ожидается Playwright storageState)");
      }
      return apiFetch<{ ok: boolean; message?: string; error?: string }>(
        "/api/settings/buyer-session/import-storage-state",
        { method: "POST", json: parsed },
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["auth-status"] }),
  });

  const profileZipM = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const base = "";
      const res = await fetch(`${base}/api/settings/buyer-session/import-profile-archive`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok) {
        throw new Error(data.error ?? res.statusText);
      }
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["auth-status"] }),
  });

  const probeM = useMutation({
    mutationFn: async (nmId: number) =>
      apiFetch<{
        ok: boolean;
        parseStatus?: string;
        priceParseSource?: string | null;
        nmId?: number;
      }>("/api/settings/parse-probe-public", {
        method: "POST",
        json: { nmId },
      }),
  });

  if (q.isLoading) {
    return <p className="text-[#8b93a7]">Загрузка статуса…</p>;
  }
  if (q.isError) {
    return <p className="text-red-400">{(q.error as Error).message}</p>;
  }
  const d = q.data!;
  const pp = d.parsePolicy;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Авторизация WB</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">
          Seller API нужен для каталога и цен в кабинете. Витрина и WB Кошелёк парсятся в режиме{" "}
          <strong className="text-[#c4c9d4]">public-first</strong>: сначала публичная карточка и popup
          детализации; buyer-session и cookies — только fallback.
        </p>
      </div>

      {pp ? (
        <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-4 text-sm text-[#c4c9d4]">
          <h2 className="text-sm font-medium text-white">Стратегия парсинга (.env)</h2>
          <ul className="mt-2 space-y-1 text-xs">
            <li>
              Режим:{" "}
              <code className="rounded bg-[#252a33] px-1">{pp.walletParseMode}</code> · verify:{" "}
              <code className="rounded bg-[#252a33] px-1">{pp.buyerVerifyMode}</code>
            </li>
            <li>
              Public-first активен:{" "}
              <span className={pp.publicFirst ? "text-emerald-300" : "text-amber-200"}>
                {pp.publicFirst ? "да" : "нет"}
              </span>
            </li>
          </ul>
        </div>
      ) : null}

      {d.message ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            pp?.publicFirst && !d.checks.buyerCookieProbe
              ? "border-[#252a33] bg-[#1a1f28] text-[#c4c9d4]"
              : "border-amber-500/35 bg-amber-500/10 text-amber-100"
          }`}
        >
          {d.message}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
          <h2 className="text-sm font-medium text-white">Seller API (токен)</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-[#c4c9d4]">
            <li>Статус в БД: {d.sellerApi.status}</li>
            <li>Проверка токена: {d.checks.sellerTokenAlive ? "ок" : "ошибка / нет токена"}</li>
            <li>Последняя валидация: {d.sellerApi.lastValidatedAt ?? "—"}</li>
            {d.sellerApi.lastError ? <li className="text-amber-200/90">Ошибка: {d.sellerApi.lastError}</li> : null}
          </ul>
        </div>
        <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
          <h2 className="text-sm font-medium text-white">Buyer / cookies (fallback)</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-[#c4c9d4]">
            <li>Сессия в БД: {d.buyerBrowser.status}</li>
            <li>
              Cookies (файл):{" "}
              {d.buyerBrowser.cookieFileExists ? (
                <span className="text-emerald-300">PRESENT</span>
              ) : (
                <span className="text-[#8b93a7]">нет</span>
              )}
            </li>
            <li>
              Probe главной WB:{" "}
              {d.checks.buyerCookieProbe ? (
                <span className="text-emerald-300">OK</span>
              ) : (
                <span className="text-amber-200">FAIL / истекло</span>
              )}
            </li>
            <li>
              Обязательный buyer-login (UI):{" "}
              <span className={d.needsBuyerLogin ? "text-amber-200" : "text-emerald-300"}>
                {d.needsBuyerLogin ? "да" : "нет"}
              </span>
            </li>
            <li className="break-all text-xs text-[#8b93a7]">Профиль: {d.buyerBrowser.profileDir}</li>
            <li className="break-all text-xs text-[#8b93a7]">
              storageState: {d.buyerBrowser.storageStatePath}
            </li>
          </ul>
        </div>
      </div>

      <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
        <h2 className="text-sm font-medium text-white">Источники цены (концепция)</h2>
        <ul className="mt-2 space-y-1 text-xs text-[#8b93a7]">
          <li>
            <span className="text-[#c4c9d4]">Public витрина</span> — основной DOM карточки без обязательного входа.
          </li>
          <li>
            <span className="text-[#c4c9d4]">Popup детализации</span> — клик по цене, если включено (не
            REPRICER_WALLET_SKIP_PRICE_DETAILS_MODAL).
          </li>
          <li>
            <span className="text-[#c4c9d4]">Cookies fallback</span> — card.wb.ru / storageState при слабом DOM.
          </li>
          <li>
            <span className="text-[#c4c9d4]">Buyer session</span> — архив профиля или CLI-логин при auth wall (редко).
          </li>
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={checkM.isPending}
          onClick={() => checkM.mutate()}
          className="rounded-lg bg-[#252a33] px-4 py-2 text-sm text-white hover:bg-[#2f3642] disabled:opacity-40"
        >
          Проверить сессии
        </button>
        <button
          type="button"
          disabled={refreshM.isPending}
          onClick={() => refreshM.mutate(false)}
          className="rounded-lg bg-blue-600/85 px-4 py-2 text-sm text-white hover:bg-blue-600 disabled:opacity-40"
        >
          Обновить cookies (фон)
        </button>
        <button
          type="button"
          disabled={refreshM.isPending}
          onClick={() => refreshM.mutate(true)}
          className="rounded-lg border border-blue-500/50 px-4 py-2 text-sm text-blue-200 hover:bg-blue-500/10 disabled:opacity-40"
        >
          Обновить buyer (окно)
        </button>
        <button
          type="button"
          disabled={loginStartM.isPending}
          onClick={() => loginStartM.mutate()}
          className="rounded-lg border border-[#3d4654] px-4 py-2 text-sm text-[#c4c9d4] hover:bg-white/5 disabled:opacity-40"
        >
          Обновить buyer session (CLI команда)
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-[#252a33] bg-[#0c0e12] p-4">
        <div>
          <label className="block text-xs text-[#8b93a7]">Проверить public parse (nmId)</label>
          <input
            className="mt-1 w-40 rounded border border-[#252a33] bg-[#13161c] px-2 py-1 text-sm text-white"
            value={probeNmId}
            onChange={(e) => setProbeNmId(e.target.value)}
            placeholder="напр. 130744302"
          />
        </div>
        <button
          type="button"
          disabled={probeM.isPending}
          onClick={() => {
            const n = Number.parseInt(probeNmId.trim(), 10);
            if (!Number.isFinite(n)) return;
            probeM.mutate(n);
          }}
          className="rounded-lg bg-emerald-700/90 px-3 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          Запустить пробу
        </button>
      </div>
      {probeM.data ? (
        <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 text-xs text-[#9aa3b5]">
          {JSON.stringify(probeM.data, null, 2)}
        </pre>
      ) : null}

      <div className="space-y-2 rounded-xl border border-[#252a33] bg-[#0c0e12] p-4">
        <p className="text-sm text-[#c4c9d4]">Импорт storageState (JSON)</p>
        <input
          type="file"
          accept="application/json,.json"
          className="text-xs text-[#8b93a7]"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importStorageM.mutate(f);
            e.target.value = "";
          }}
        />
        {importStorageM.isSuccess ? (
          <p className="text-xs text-emerald-300">{(importStorageM.data as { message?: string }).message}</p>
        ) : null}
        {importStorageM.isError ? (
          <p className="text-xs text-red-300">{(importStorageM.error as Error).message}</p>
        ) : null}
      </div>

      <div className="space-y-2 rounded-xl border border-[#252a33] bg-[#0c0e12] p-4">
        <p className="text-sm text-[#c4c9d4]">Импорт архива профиля браузера (.zip)</p>
        <input
          type="file"
          accept=".zip,application/zip"
          className="text-xs text-[#8b93a7]"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) profileZipM.mutate(f);
            e.target.value = "";
          }}
        />
        {profileZipM.isSuccess ? (
          <p className="text-xs text-emerald-300">{(profileZipM.data as { message?: string }).message}</p>
        ) : null}
        {profileZipM.isError ? (
          <p className="text-xs text-red-300">{(profileZipM.error as Error).message}</p>
        ) : null}
      </div>

      {refreshM.data ? (
        <p className={`text-sm ${refreshM.data.ok ? "text-emerald-300" : "text-red-300"}`}>
          {refreshM.data.message}
        </p>
      ) : null}

      {loginStartM.data ? (
        <div className="rounded-xl border border-[#252a33] bg-[#0c0e12] p-4 text-sm text-[#c4c9d4]">
          {loginStartM.data.headedLoginAvailable === false ? (
            <p className="mb-2 text-amber-100">{loginStartM.data.headedLoginNote}</p>
          ) : null}
          <p className="mb-2">{loginStartM.data.instruction}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/40 p-3 text-xs text-[#9aa3b5]">
            {loginStartM.data.cliCommand}
          </pre>
          {loginStartM.data.alternative ? (
            <p className="mt-2 text-xs text-[#8b93a7]">{loginStartM.data.alternative}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
