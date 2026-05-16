import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Tags, Package, History, Settings, LogOut, ChevronDown, Check, Store } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "../lib/utils";
import { useSessionStore } from "../store/session";
import { apiFetch } from "../lib/api";

const nav = [
  { to: "/", label: "Цены", icon: Tags },
  { to: "/catalog", label: "Каталог", icon: Package },
  { to: "/history", label: "История", icon: History },
  { to: "/settings", label: "Настройки", icon: Settings },
];

type Cabinet = {
  id: string;
  name: string;
  tokenLast4: string;
  isActive: boolean;
  productsCount: number;
};

function CabinetSwitcher({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const cabinetsQ = useQuery({
    queryKey: ["cabinets"],
    queryFn: () => apiFetch<{ items: Cabinet[] }>("/api/cabinets"),
    staleTime: 30_000,
  });

  const activate = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cabinets/${id}/activate`, { method: "POST" }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["cabinets"] });
      void qc.invalidateQueries({ queryKey: ["floor-region-prices"] });
      void qc.invalidateQueries({ queryKey: ["catalog-v2"] });
      void qc.invalidateQueries({ queryKey: ["wb-status"] });
    },
  });

  const cabinets = cabinetsQ.data?.items ?? [];
  const active = cabinets.find((c) => c.isActive);

  if (cabinets.length < 2) {
    if (!active) return null;
    return (
      <div className={cn("flex items-center gap-2", compact ? "px-2 py-1" : "px-3 py-2")}>
        <Store className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        <span className="truncate text-xs text-[#c4c9d4]">{active.name}</span>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg text-left text-sm transition-colors hover:bg-white/5",
          compact ? "px-2 py-1.5" : "px-3 py-2",
        )}
      >
        <Store className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        <span className="min-w-0 flex-1 truncate text-xs text-[#c4c9d4]">
          {active?.name ?? "Магазин"}
        </span>
        <ChevronDown
          className={cn("h-3 w-3 shrink-0 text-[#5a6170] transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 z-20 mt-1 rounded-lg border border-[#252a33] bg-[#0d0f14] py-1 shadow-xl">
            {cabinets.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={activate.isPending}
                onClick={() => {
                  if (!c.isActive) activate.mutate(c.id);
                  else setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors",
                  c.isActive
                    ? "text-blue-300"
                    : "text-[#c4c9d4] hover:bg-white/5 hover:text-white",
                )}
              >
                <Check
                  className={cn("h-3 w-3 shrink-0", c.isActive ? "opacity-100" : "opacity-0")}
                />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="shrink-0 text-[10px] text-[#5a6170]">{c.productsCount} тов.</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function Shell() {
  const setToken = useSessionStore((s) => s.setToken);
  return (
    <div className="flex min-h-full">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-[#252a33] bg-[#13161c] md:flex">
        <div className="border-b border-[#252a33] px-4 py-4">
          <div className="text-sm font-semibold tracking-tight text-white">WB Repricer</div>
          <div className="mt-0.5 text-xs text-[#8b93a7]">Защита минимальной цены</div>
          <div className="mt-2">
            <CabinetSwitcher />
          </div>
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
          <div className="w-40">
            <CabinetSwitcher compact />
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 pb-20 md:p-8 md:pb-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
