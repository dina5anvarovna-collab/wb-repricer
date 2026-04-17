import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "./components/Shell";
import { ApiError, apiFetch } from "./lib/api";
import { DashboardPage } from "./pages/DashboardPage";
import { ConnectPage } from "./pages/ConnectPage";
import { CatalogPage } from "./pages/CatalogPage";
import { RulesPage } from "./pages/RulesPage";
import { MonitorPage } from "./pages/MonitorPage";
import { HistoryPage } from "./pages/HistoryPage";
import { RegionsPage } from "./pages/RegionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { SessionPage } from "./pages/SessionPage";
import { StocksPage } from "./pages/StocksPage";
import { PricesPage } from "./pages/PricesPage";
import { ProductsApiPage } from "./pages/ProductsApiPage";
import { SyncLogsPage } from "./pages/SyncLogsPage";
import { SyncHubPage } from "./pages/SyncHubPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 0, refetchOnWindowFocus: false },
  },
});

function isLikelyNetworkFailure(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e instanceof Error && /failed to fetch|networkerror|load failed|fetch/i.test(e.message)) {
    return true;
  }
  return false;
}

function ProtectedLayout() {
  const [ready, setReady] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    let cancelled = false;
    void apiFetch<unknown>("/api/app/settings")
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          nav("/login", { replace: true });
          return;
        }
        if (isLikelyNetworkFailure(e)) {
          setGateError(
            "Браузер не достучался до API. Запустите сервер в папке WB_Repricer: npm run dev (порт 3001). Если открываете только Vite (5173), backend тоже должен быть запущен.",
          );
          setReady(true);
          return;
        }
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nav]);
  if (gateError) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-lg text-red-300">{gateError}</p>
        <p className="max-w-lg text-sm text-[#8b93a7]">
          <strong className="text-white">Вариант А:</strong> одна команда —{" "}
          <code className="rounded bg-[#252a33] px-1">npm run build:all && npm start</code>, затем в браузере{" "}
          <code className="rounded bg-[#252a33] px-1">http://127.0.0.1:3001/</code>
          <br />
          <strong className="text-white">Вариант Б:</strong> два терминала —{" "}
          <code className="rounded bg-[#252a33] px-1">npm run dev</code> и{" "}
          <code className="rounded bg-[#252a33] px-1">npm run dev:web</code> →{" "}
          <code className="rounded bg-[#252a33] px-1">http://127.0.0.1:5173</code>
        </p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-[#8b93a7]">
        Проверка доступа…
      </div>
    );
  }
  return <Outlet />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route element={<Shell />}>
          <Route index element={<DashboardPage />} />
          <Route path="connect" element={<ConnectPage />} />
          <Route path="catalog" element={<CatalogPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="monitor" element={<MonitorPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="regions" element={<RegionsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="session" element={<SessionPage />} />
          <Route path="stocks" element={<StocksPage />} />
          <Route path="prices" element={<PricesPage />} />
          <Route path="products-api" element={<ProductsApiPage />} />
          <Route path="sync" element={<SyncHubPage />} />
          <Route path="sync-logs" element={<SyncLogsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
