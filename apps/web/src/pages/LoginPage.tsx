import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "../lib/api";
import { useSessionStore } from "../store/session";

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const setToken = useSessionStore((s) => s.setToken);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const data = await apiFetch<{ success?: boolean; data?: { token?: string }; error?: { message?: string } }>(
        "/api/auth/login",
        { method: "POST", json: { password } },
      );
      if (!data.success || !data.data?.token) {
        setErr(data.error?.message ?? "Ошибка входа");
        return;
      }
      setToken(data.data.token);
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(e.message || "Ошибка входа");
        return;
      }
      setErr("Не удалось связаться с сервером. Запущен ли API на порту 3001?");
      return;
    }
    navigate("/", { replace: true });
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 pt-16">
      <div>
        <h1 className="text-xl font-semibold text-white">Вход в панель</h1>
        <p className="mt-1 text-sm text-[#8b93a7]">
          Укажите пароль из переменной окружения REPRICER_ADMIN_PASSWORD
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-[#252a33] bg-[#13161c] p-6">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[#c4c9d4]">Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-[#252a33] bg-[#0c0e12] px-3 py-2 text-white outline-none focus:border-blue-500"
            autoComplete="current-password"
          />
        </label>
        {err ? <p className="text-sm text-red-400">{err}</p> : null}
        <button
          type="submit"
          className="rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Войти
        </button>
      </form>
    </div>
  );
}
