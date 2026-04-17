import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

type Dashboard = {
  totalProducts: number;
  protectionRulesEnabled: number;
  priceRaisesToday: number;
  failedOperationsToday: number;
  stats?: {
    belowMinCount: number;
    parseFailedCount: number;
    needsReviewCount: number;
    priceMismatchApproxCount?: number;
    zeroStockCount?: number;
    lowStockCount?: number;
    lastCatalogSyncAt?: string | null;
    successfulUploadsToday: number;
    failedAttemptsToday: number;
    lastMonitorAt: string | null;
    lastMonitorStatus: string | null;
    lastMonitorParseStats?: Record<string, number> | null;
  };
  seller: { configured: boolean; tokenValid: boolean | null; tokenLast4: string | null };
  buyer: {
    active: boolean;
    lastDomSuccessAt: string | null;
    status: string;
  };
  protection: { globalPause: boolean; emergencyStop: boolean };
  publicWalletParse?: {
    buyerAuthDisabled: boolean;
    publicOnly: boolean;
    walletParseMode: string;
    walletDetailsMode: string;
    monitorSppViaCookies: boolean;
    safeModeHoldProducts: number;
    lastKnownGoodSample: {
      nmId: number;
      walletRubLastGood: number | null;
      walletRubLastGoodAt: string | null;
      sourceLastGood: string | null;
      parseStatusLastGood: string | null;
      safeModeHold: boolean;
    } | null;
  };
};

function Card({
  title,
  value,
  hint,
}: {
  title: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-[#8b93a7]">{title}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums text-white">{value}</div>
      {hint ? <div className="mt-1 text-xs text-[#8b93a7]">{hint}</div> : null}
    </div>
  );
}

export function DashboardPage() {
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiFetch<Dashboard>("/api/dashboard"),
  });
  if (q.isLoading) {
    return <p className="text-[#8b93a7]">Загрузка…</p>;
  }
  if (q.isError) {
    return <p className="text-red-400">{(q.error as Error).message}</p>;
  }
  const d = q.data!;
  const st = d.stats;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">Дашборд</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">Сводка по кабинету, мониторингу и защите цен</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card title="Товары в каталоге" value={d.totalProducts} />
        <Card title="Под контролем" value={d.protectionRulesEnabled} />
        <Card title="Ниже минимума" value={st?.belowMinCount ?? "—"} hint="по последнему мониторингу" />
        <Card title="Ошибка парсинга" value={st?.parseFailedCount ?? "—"} />
        <Card title="Нужен разбор" value={st?.needsReviewCount ?? "—"} hint="только витрина без кошелька" />
        <Card title="Выгрузок сегодня" value={d.priceRaisesToday} />
        <Card title="Сбоев сегодня" value={d.failedOperationsToday} />
        <Card
          title="Последний мониторинг"
          value={st?.lastMonitorAt ? new Date(st.lastMonitorAt).toLocaleString("ru-RU") : "—"}
          hint={st?.lastMonitorStatus ?? undefined}
        />
        <Card title="Без остатка" value={st?.zeroStockCount ?? "—"} hint="stock 0 или нет данных" />
        <Card title="Низкий остаток" value={st?.lowStockCount ?? "—"} hint="1…4 шт." />
        <Card
          title="Расхождение цен (оценка)"
          value={st?.priceMismatchApproxCount ?? "—"}
          hint="ниже мин. + нужен разбор"
        />
        <Card
          title="Последняя синхр. каталога"
          value={
            st?.lastCatalogSyncAt ? new Date(st.lastCatalogSyncAt).toLocaleString("ru-RU") : "—"
          }
          hint="POST /api/sync/all"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
          <h2 className="text-sm font-medium text-white">Токен продавца</h2>
          <ul className="mt-3 space-y-2 text-sm text-[#c4c9d4]">
            <li>Сохранён: {d.seller.configured ? "да" : "нет"}</li>
            <li>Проверка API: {d.seller.tokenValid === null ? "—" : d.seller.tokenValid ? "ок" : "ошибка"}</li>
            <li>Последние 4 символа: {d.seller.tokenLast4 ?? "—"}</li>
          </ul>
        </div>
        {d.publicWalletParse?.buyerAuthDisabled ? (
          <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
            <h2 className="text-sm font-medium text-white">Публичный парсинг WB</h2>
            <ul className="mt-3 space-y-2 text-sm text-[#c4c9d4]">
              <li>
                Режим: <code className="rounded bg-[#252a33] px-1">{d.publicWalletParse.walletParseMode}</code> ·
                popup:{" "}
                <code className="rounded bg-[#252a33] px-1">{d.publicWalletParse.walletDetailsMode}</code>
              </li>
              <li>
                Safe mode (товары):{" "}
                <span className={d.publicWalletParse.safeModeHoldProducts > 0 ? "text-amber-200" : "text-emerald-300"}>
                  {d.publicWalletParse.safeModeHoldProducts > 0
                    ? `YES (${d.publicWalletParse.safeModeHoldProducts})`
                    : "NO"}
                </span>
              </li>
              <li>
                Последний известный wallet (last good):{" "}
                {d.publicWalletParse.lastKnownGoodSample?.walletRubLastGood != null
                  ? `${Math.round(d.publicWalletParse.lastKnownGoodSample.walletRubLastGood)} ₽`
                  : "—"}
                {d.publicWalletParse.lastKnownGoodSample?.walletRubLastGoodAt
                  ? ` · ${new Date(d.publicWalletParse.lastKnownGoodSample.walletRubLastGoodAt).toLocaleString("ru-RU")}`
                  : ""}
              </li>
              <li className="text-xs text-[#8b93a7]">
                Buyer-auth отключён — мониторинг без cookies expiry и без relogin.
              </li>
            </ul>
          </div>
        ) : (
          <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-5">
            <h2 className="text-sm font-medium text-white">Сессия покупателя (legacy)</h2>
            <ul className="mt-3 space-y-2 text-sm text-[#c4c9d4]">
              <li>Активна: {d.buyer.active ? "да" : "нет"}</li>
              <li>Статус: {d.buyer.status}</li>
              <li>
                Последняя успешная DOM-проверка:{" "}
                {d.buyer.lastDomSuccessAt
                  ? new Date(d.buyer.lastDomSuccessAt).toLocaleString("ru-RU")
                  : "—"}
              </li>
            </ul>
          </div>
        )}
      </div>
      {st?.lastMonitorParseStats ? (
        <div className="rounded-xl border border-[#252a33] bg-[#13161c] p-4">
          <h2 className="text-sm font-medium text-white">Последний мониторинг — источники парсинга</h2>
          <pre className="mt-2 overflow-x-auto text-xs text-[#9aa3b5]">
            {JSON.stringify(st.lastMonitorParseStats, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-[#8b93a7]">
            publicDom / popupDom / unknown / authWall / captcha / safeModeLastGood — счётчики по шагам nm×регион.
          </p>
        </div>
      ) : null}
      {(d.protection.globalPause || d.protection.emergencyStop) && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {d.protection.globalPause ? "Включена глобальная пауза защиты. " : ""}
          {d.protection.emergencyStop ? "Включён аварийный стоп." : ""}
        </div>
      )}
    </div>
  );
}
