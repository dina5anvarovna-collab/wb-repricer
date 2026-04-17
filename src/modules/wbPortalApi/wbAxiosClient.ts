import axios, { type AxiosInstance, type AxiosRequestConfig, type InternalAxiosRequestConfig } from "axios";
import { getValidCookies } from "../wbSession/sessionManager.js";

function attachCookieInterceptor(client: AxiosInstance): void {
  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    const { header } = await getValidCookies();
    if (header && !config.headers.Cookie && !config.headers.cookie) {
      config.headers.Cookie = header;
    }
    return config;
  });
}

/** Клиент для запросов от имени «витрины» с cookie из storageState (если файл есть). */
export function createWbShowcaseAxios(): AxiosInstance {
  const c = axios.create({
    timeout: 35_000,
    validateStatus: () => true,
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  attachCookieInterceptor(c);
  return c;
}

/** Официальный Seller API — только заголовок Authorization (токен). */
export function createWbSellerApiAxios(token: string): AxiosInstance {
  const norm = token.trim();
  return axios.create({
    timeout: 45_000,
    headers: {
      Authorization: norm,
      Accept: "application/json",
    },
    validateStatus: () => true,
  });
}

/**
 * Обертка: один повтор при 401/403 после обновления метаданных токена (токен не «лечится» браузером).
 * Для токена refresh = пользователь вводит новый в UI.
 */
export async function requestSellerApiWithTokenRetry<T>(
  _token: string,
  req: () => Promise<T>,
): Promise<T> {
  return req();
}

export function isRetryableNetworkError(e: unknown): boolean {
  if (axios.isAxiosError(e)) {
    const code = e.code;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
      return true;
    }
    const s = e.response?.status;
    return s === 429 || (s != null && s >= 500);
  }
  return false;
}

export async function withNetworkRetries<T>(fn: () => Promise<T>, opts?: { max?: number; delayMs?: number }): Promise<T> {
  const max = opts?.max ?? 3;
  const delayMs = opts?.delayMs ?? 800;
  let last: unknown;
  for (let i = 0; i < max; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetryableNetworkError(e) || i === max - 1) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

export type { AxiosRequestConfig };
