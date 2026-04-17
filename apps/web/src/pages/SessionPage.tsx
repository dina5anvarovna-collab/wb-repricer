import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../lib/api";

type ParsePolicy = {
  publicFirst: boolean;
  walletParseMode: string;
  buyerVerifyMode: string;
};

type PublicParsingEnv = {
  buyerAuthDisabled: boolean;
  publicOnly: boolean;
  walletParseMode?: string;
  walletDetailsMode: string;
  monitorSppViaCookies: boolean;
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
  publicParsing?: PublicParsingEnv;
};

type PublicParseStatusPayload = {
  buyerAuthDisabled: boolean;
  publicOnly: boolean;
  lastPublicProbe: {
    at: string;
    nmId: number | null;
    ok: boolean;
    parseStatus: string | null;
    blockReason: string | null;
    priceParseSource: string | null;
    confidence: number | null;
    browserUrlAfterParse: string | null;
    pageTitle: string | null;
    attemptCount: number;
    debugArtifactPaths: string[];
  } | null;
  env: Record<string, string>;
  lastMonitorJob: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    processedProducts: unknown;
  } | null;
  parseStats: Record<string, number> | null;
  interpretation: {
    publicDomOk: boolean | null;
    popupParseOk: boolean | null;
    walletMarkersLikely: boolean | null;
    parseSourceMix: Record<string, unknown>;
    confidenceNote: string;
  } | null;
  safeMode: {
    activeProducts: number;
    lastKnownGood: {
      nmId: number;
      walletRubLastGood: number | null;
      walletRubLastGoodAt: string | null;
      sourceLastGood: string | null;
      parseStatusLastGood: string | null;
      safeModeHold: boolean;
    } | null;
  };
};

function yn(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v ? "YES" : "NO";
}

function okfail(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v ? "OK" : "FAIL";
}

export function SessionPage() {
  const qc = useQueryClient();
  const [probeNmId, setProbeNmId] = useState("");
  const q = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => apiFetch<AuthStatus>("/api/auth/status"),
  });

  const pub = useQuery({
    queryKey: ["public-parse-status"],
    queryFn: () => apiFetch<PublicParseStatusPayload>("/api/public-parse/status"),
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
        blockReason?: string | null;
        priceParseSource?: string | null;
        nmId?: number;
        browserUrlAfterParse?: string | null;
        pageTitle?: string | null;
        confidence?: number;
        debugArtifactPaths?: string[];
        attemptCount?: number;
      }>("/api/settings/parse-probe-public", {
        method: "POST",
        json: { nmId },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-parse-status"] }),
  });

  if (q.isLoading) {
    return <p className="text-[#8b93a7]">Загрузка статуса…</p>;
  }
  if (q.isError) {
    return <p className="text-red-400">{(q.error as Error).message}</p>;
  }
  const d = q.data!;
  const ppolicy = d.publicParsing ?? d.parsePolicy;
  const buyerOff = d.publicParsing?.buyerAuthDisabled ?? false;
  const pp = d.parsePolicy;

  const interpretation = pub.data?.interpretation;
  const stats = pub.data?.parseStats;
  const mix = interpretation?.parseSourceMix as Record<string, number> | undefined;
  const confidence =
    mix && typeof stats?.publicDom === "number"
      ? Math.min(
          1,
          ((stats.publicDom ?? 0) + (stats.popupDom ?? 0)) /
            Math.max(1, (stats.publicDom ?? 0) + (stats.popupDom ?? 0) + (stats.unknown ?? 0)),
        )
      : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Парсинг и доступы WB</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">
          Seller API нужен для каталога и цен кабинета. Цена WB Кошелька берётся с{" "}
          <strong className="text-[#c4c9d4]">публичной карточки</strong> и при необходимости из{" "}
          <strong className="text-[#c4c9d4]">popup детализации</strong>
          {buyerOff ? (
            <> — режим без buyer-login и без cookies ({d.parsePolicy?.walletParseMode ?? "public_only"}).</>
          ) : (
            <> (legacy: опционально buyer-session как fallback).</>
          )}
        </p>
      </div>

      {pp ? (
        <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-4 text-sm text-[#c4c9d4]">
          <h2 className="text-sm font-medium text-white">Стратегия парсинга (.env)</h2>
          <ul className="mt-2 space-y-1 text-xs">
            <li>
              Режим: <code className="rounded bg-[#252a33] px-1">{pp.walletParseMode}</code> · verify:{" "}
              <code className="rounded bg-[#252a33] px-1">{pp.buyerVerifyMode}</code>
            </li>
            <li>
              Public-first (legacy поле):{" "}
              <span className={pp.publicFirst ? "text-emerald-300" : "text-amber-200"}>
                {pp.publicFirst ? "да" : "нет"}
              </span>
            </li>
            {ppolicy && "walletDetailsMode" in ppolicy ? (
              <li>
                Детали цены (popup):{" "}
                <code className="rounded bg-[#252a33] px-1">
                  {(ppolicy as PublicParsingEnv).walletDetailsMode}
                </code>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {d.message ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            buyerOff || (pp?.publicFirst && !d.checks.buyerCookieProbe)
              ? "border-[#252a33] bg-[#1a1f28] text-[#c4c9d4]"
              : "border-amber-500/35 bg-amber-500/10 text-amber-100"
          }`}
        >
          {d.message}
        </div>
      ) : null}

      <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
        <h2 className="text-sm font-medium text-white">Публичный парсинг WB</h2>
        <ul className="mt-3 space-y-1.5 text-sm text-[#c4c9d4]">
          <li>
            Public DOM (последний мониторинг):{" "}
            <span className="tabular-nums text-white">{okfail(interpretation?.publicDomOk ?? null)}</span>
          </li>
          <li>
            Popup parse:{" "}
            <span className="tabular-nums text-white">{okfail(interpretation?.popupParseOk ?? null)}</span>
          </li>
          <li>
            Wallet detected (по шагам с DOM/popup):{" "}
            <span className="tabular-nums text-white">{yn(interpretation?.walletMarkersLikely)}</span>
          </li>
          <li>
            Parse source mix:{" "}
            <span className="text-xs text-[#8b93a7]">
              public_dom={stats?.publicDom ?? "—"}, popup_dom={stats?.popupDom ?? "—"}, unknown=
              {stats?.unknown ?? "—"}
            </span>
          </li>
          <li>
            Confidence (оценка доли успешных доменов):{" "}
            <span className="tabular-nums text-white">
              {confidence != null ? confidence.toFixed(2) : "—"}
            </span>
          </li>
          <li>
            Last success at (job):{" "}
            <span className="text-white">
              {pub.data?.lastMonitorJob?.finishedAt
                ? new Date(pub.data.lastMonitorJob.finishedAt).toLocaleString("ru-RU")
                : pub.data?.lastMonitorJob?.startedAt
                  ? new Date(pub.data.lastMonitorJob.startedAt).toLocaleString("ru-RU")
                  : "—"}
            </span>
          </li>
          <li>
            Last known good value:{" "}
            <span className="text-white">
              {pub.data?.safeMode.lastKnownGood?.walletRubLastGood != null
                ? `${Math.round(pub.data.safeMode.lastKnownGood.walletRubLastGood)} ₽`
                : "—"}
              {pub.data?.safeMode.lastKnownGood?.walletRubLastGoodAt
                ? ` · ${new Date(pub.data.safeMode.lastKnownGood.walletRubLastGoodAt).toLocaleString("ru-RU")}`
                : ""}
            </span>
          </li>
          <li>
            Safe mode active (товары):{" "}
            <span className={pub.data?.safeMode.activeProducts ? "text-amber-200" : "text-emerald-300"}>
              {pub.data?.safeMode.activeProducts ? "YES" : "NO"}
              {pub.data?.safeMode.activeProducts ? ` (${pub.data.safeMode.activeProducts} шт.)` : ""}
            </span>
          </li>
        </ul>
        {pub.isLoading ? <p className="mt-2 text-xs text-[#8b93a7]">Загрузка сводки…</p> : null}
        {interpretation?.confidenceNote ? (
          <p className="mt-2 text-xs text-[#8b93a7]">{interpretation.confidenceNote}</p>
        ) : null}
        {pub.data?.lastPublicProbe ? (
          <div className="mt-4 rounded-lg border border-[#252a33] bg-[#0c0e12] p-3 text-xs text-[#c4c9d4]">
            <p className="font-medium text-[#e8eaef]">Последняя проба public parse</p>
            <ul className="mt-2 space-y-1 font-mono text-[11px] leading-relaxed">
              <li>
                Время:{" "}
                <span className="text-[#c4c9d4]">
                  {new Date(pub.data.lastPublicProbe.at).toLocaleString("ru-RU")}
                </span>
              </li>
              <li>
                nmId: <span className="text-white">{pub.data.lastPublicProbe.nmId ?? "—"}</span>
              </li>
              <li>
                parseStatus:{" "}
                <span className="text-white">{pub.data.lastPublicProbe.parseStatus ?? "—"}</span>
              </li>
              <li>
                Причина / blockReason:{" "}
                <span className="text-amber-200">{pub.data.lastPublicProbe.blockReason ?? "—"}</span>
              </li>
              <li className="break-all">
                URL после парсинга:{" "}
                <span className="text-[#8cb4ff]">{pub.data.lastPublicProbe.browserUrlAfterParse ?? "—"}</span>
              </li>
              <li className="break-all">
                title: <span className="text-[#c4c9d4]">{pub.data.lastPublicProbe.pageTitle ?? "—"}</span>
              </li>
              <li>
                Попыток:{" "}
                <span className="text-white">{pub.data.lastPublicProbe.attemptCount ?? "—"}</span>
              </li>
            </ul>
            {pub.data.lastPublicProbe.debugArtifactPaths &&
            pub.data.lastPublicProbe.debugArtifactPaths.length > 0 ? (
              <div className="mt-2 text-[11px] text-[#8b93a7]">
                Debug файлы:
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {pub.data.lastPublicProbe.debugArtifactPaths.map((p, i) => (
                    <li key={i} className="break-all">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-xs text-[#8b93a7]">Последняя проба ещё не выполнялась на этом процессе.</p>
        )}
      </div>

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

        {!buyerOff ? (
          <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
            <h2 className="text-sm font-medium text-white">Buyer / cookies (legacy fallback)</h2>
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
        ) : (
          <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
            <h2 className="text-sm font-medium text-white">Buyer / cookies</h2>
            <p className="mt-2 text-sm text-[#8b93a7]">
              Отключено в конфигурации (<code className="text-[#c4c9d4]">REPRICER_DISABLE_BUYER_AUTH</code>).
              Мониторинг использует эфемерный профиль браузера без сохранённой buyer-сессии.
            </p>
          </div>
        )}
      </div>

      {!buyerOff ? (
        <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
          <h2 className="text-sm font-medium text-white">Источники цены (legacy)</h2>
          <ul className="mt-2 space-y-1 text-xs text-[#8b93a7]">
            <li>
              <span className="text-[#c4c9d4]">Public витрина</span> — основной DOM карточки.
            </li>
            <li>
              <span className="text-[#c4c9d4]">Popup детализации</span> — по клику на цену (если не отключено в .env).
            </li>
            <li>
              <span className="text-[#c4c9d4]">Cookies / card.wb.ru</span> — опционально при включённом buyer auth.
            </li>
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={checkM.isPending}
          onClick={() => checkM.mutate()}
          className="rounded-lg bg-[#252a33] px-4 py-2 text-sm text-white hover:bg-[#2f3642] disabled:opacity-40"
        >
          Проверить Seller API
        </button>
        {!buyerOff ? (
          <>
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
              CLI buyer login
            </button>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-[#252a33] bg-[#0c0e12] p-4">
        <div>
          <label className="block text-xs text-[#8b93a7]">Проба public parse (nmId)</label>
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
        <div className="space-y-2 rounded-lg bg-black/40 p-3 text-xs text-[#c4c9d4]">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>
              ok:{" "}
              <strong className={probeM.data.ok ? "text-emerald-400" : "text-red-400"}>
                {probeM.data.ok ? "yes" : "no"}
              </strong>
            </span>
            <span>
              parseStatus: <strong className="text-white">{probeM.data.parseStatus ?? "—"}</strong>
            </span>
            <span>
              blockReason:{" "}
              <strong className="text-amber-200">{probeM.data.blockReason ?? "—"}</strong>
            </span>
            <span>
              attemptCount:{" "}
              <strong className="text-white">{probeM.data.attemptCount ?? "—"}</strong>
            </span>
          </div>
          <p className="break-all text-[11px] text-[#8cb4ff]">{probeM.data.browserUrlAfterParse ?? ""}</p>
          <p className="break-all text-[11px] text-[#9aa3b5]">{probeM.data.pageTitle ?? ""}</p>
          {probeM.data.debugArtifactPaths && probeM.data.debugArtifactPaths.length > 0 ? (
            <div className="text-[11px] text-[#8b93a7]">
              Debug:
              <ul className="mt-1 list-inside list-disc">
                {probeM.data.debugArtifactPaths.map((p, i) => (
                  <li key={i} className="break-all">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <details className="text-[11px] text-[#8b93a7]">
            <summary className="cursor-pointer text-[#c4c9d4]">Полный JSON</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-[#9aa3b5]">
              {JSON.stringify(probeM.data, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}

      {!buyerOff ? (
        <>
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
        </>
      ) : null}

      {refreshM.data && !buyerOff ? (
        <p className={`text-sm ${refreshM.data.ok ? "text-emerald-300" : "text-red-300"}`}>
          {refreshM.data.message}
        </p>
      ) : null}

      {loginStartM.data && !buyerOff ? (
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
