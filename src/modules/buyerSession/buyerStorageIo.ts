import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { runtimePaths } from "../../lib/runtimePaths.js";

const TAG = "buyer-storage-io";

export type StorageStateShape = {
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  origins?: unknown[];
};

/**
 * Куки витрины (www.wildberries.ru и смежные хосты) для запросов к card.wb.ru и оценки СПП.
 * Без живого входа покупателя в persistent-профиль Playwright «взять куки с сайта» нельзя — их нет в публичном HTTP.
 */
export function isWbShowcaseCookieDomain(raw: string): boolean {
  const d0 = raw.trim().toLowerCase();
  if (!d0) return false;
  const d = d0.startsWith(".") ? d0.slice(1) : d0;
  if (d === "wildberries.ru" || d === "www.wildberries.ru" || d === "m.wildberries.ru") {
    return true;
  }
  if (d.endsWith(".wildberries.ru") || d.endsWith(".wb.ru")) {
    return true;
  }
  return false;
}

/** Должен совпадать с resolveBuyerProfileDir() в catalogSync (единый путь к persistent profile). */
export function resolveBuyerProfileDirAbs(): string {
  const raw = env.BUYER_PROFILE_DIR || env.REPRICER_BUYER_PROFILE_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(runtimePaths.projectRoot, raw);
}

export function resolveStorageStatePathAbs(): string {
  const raw = env.BUYER_STATE_PATH || env.REPRICER_WB_STORAGE_STATE_PATH;
  return path.isAbsolute(raw) ? raw : path.resolve(runtimePaths.projectRoot, raw);
}

export function normalizeCookies(state: StorageStateShape): string {
  const parts = state.cookies
    .filter((c) => isWbShowcaseCookieDomain(c.domain))
    .map((c) => `${c.name}=${c.value}`);
  return parts.join("; ");
}

export async function loadSavedSession(): Promise<StorageStateShape | null> {
  const p = resolveStorageStatePathAbs();
  try {
    const raw = await fsp.readFile(p, "utf8");
    const j = JSON.parse(raw) as StorageStateShape;
    if (!j?.cookies || !Array.isArray(j.cookies)) {
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

export async function saveSession(state: StorageStateShape): Promise<void> {
  const p = resolveStorageStatePathAbs();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(state, null, 2), "utf8");
  logger.info({ tag: TAG, path: p }, "storageState записан на диск (экспорт из persistent profile)");
}

export function exportCookieHeader(state: StorageStateShape | null): string | null {
  if (!state?.cookies?.length) {
    return null;
  }
  const h = normalizeCookies(state);
  return h.length > 0 ? h : null;
}
