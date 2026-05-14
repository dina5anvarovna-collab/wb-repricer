import { NavLink, Outlet } from "react-router-dom";
import { Tags, Package, History, Settings, LogOut } from "lucide-react";
import { cn } from "../lib/utils";
import { useSessionStore } from "../store/session";

const nav = [
  { to: "/", label: "Цены", icon: Tags },
  { to: "/catalog", label: "Каталог", icon: Package },
  { to: "/history", label: "История", icon: History },
  { to: "/settings", label: "Настройки", icon: Settings },
];

export function Shell() {
  const setToken = useSessionStore((s) => s.setToken);
  return (
    <div className="flex min-h-full">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-[#252a33] bg-[#13161c] md:flex">
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
            Выйти
          </button>
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex border-t border-[#252a33] bg-[#13161c] md:hidden">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px]",
                isActive ? "text-blue-300" : "text-[#8b93a7]",
              )
            }
          >
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[#252a33] bg-[#13161c]/80 px-4 py-3 backdrop-blur md:hidden">
          <span className="text-sm font-semibold text-white">WB Repricer</span>
        </header>
        <main className="flex-1 overflow-auto p-4 pb-20 md:p-8 md:pb-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
