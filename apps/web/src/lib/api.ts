import { useSessionStore } from "../store/session";

/** Если UI открыт не с того же origin (редко), задайте VITE_API_BASE=http://127.0.0.1:3001 при сборке. */
function apiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const base =
    typeof import.meta !== "undefined" &&
    import.meta.env &&
    typeof import.meta.env.VITE_API_BASE === "string"
      ? import.meta.env.VITE_API_BASE.trim().replace(/\/$/, "")
      : "";
  return `${base}${path}`;
}

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const token = useSessionStore.getState().token;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(apiUrl(path), { ...init, headers, body });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    let msg = res.statusText;
    if (typeof data === "object" && data && "error" in data) {
      const errField = (data as { error?: unknown }).error;
      if (typeof errField === "string" && errField.trim()) {
        msg = errField;
      } else if (
        typeof errField === "object" &&
        errField &&
        "message" in errField &&
        typeof (errField as { message?: unknown }).message === "string"
      ) {
        msg = String((errField as { message: string }).message);
      }
    } else if (typeof data === "object" && data && "message" in data) {
      msg = String((data as { message?: string }).message);
    }
    throw new ApiError(msg || `HTTP ${res.status}`, res.status, data);
  }
  return data as T;
}
