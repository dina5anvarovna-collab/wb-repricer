import { NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Plug,
  Package,
  Shield,
  Activity,
  History,
  MapPin,
  Settings,
  LogOut,
  KeyRound,
  Boxes,
  Tags,
  RefreshCw,
  ScrollText,
  LayoutList,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useSessionStore } from "../store/session";

const nav = [
  { to: "/", label: "Дашборд", icon: LayoutDashboard },
  { to: "/connect", label: "Подключение WB", icon: Plug },
  { to: "/session", label: "Парсинг WB", icon: KeyRound },
  { to: "/sync", label: "Синхронизация", icon: RefreshCw },
  { to: "/catalog", label: "Каталог", icon: Package },
  { to: "/products-api", label: "Товары (API)", icon: LayoutList },
  { to: "/stocks", label: "Остатки", icon: Boxes },
  { to: "/prices", label: "Цены и скидки", icon: Tags },
  { to: "/sync-logs", label: "Логи синхронизаций", icon: ScrollText },
  { to: "/rules", label: "Минимальные цены", icon: Shield },
  { to: "/monitor", label: "Мониторинг", icon: Activity },
  { to: "/history", label: "История", icon: History },
  { to: "/regions", label: "Регионы", icon: MapPin },
  { to: "/settings", label: "Настройки", icon: Settings },
];

export function Shell() {
  const setToken = useSessionStore((s) => s.setToken);
  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-[#252a33] bg-[#13161c] md:flex">
        <div className="border-b border-[#252a33] px-4 py-5">
          <div className="text-sm font-semibold tracking-tight text-white">WB Repricer</div>
          <div className="text-xs text-[#8b93a7]">Защита минимальной цены</div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-blue-600/20 text-blue-200"
                    : "text-[#c4c9d4] hover:bg-white/5 hover:text-white",
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0 opacity-80" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[#252a33] p-2">
          <button
            type="button"
            onClick={() => setToken(null)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-[#8b93a7] hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            Выйти из сессии
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[#252a33] bg-[#13161c]/80 px-4 py-3 backdrop-blur md:hidden">
          <span className="text-sm font-medium">WB Repricer</span>
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
