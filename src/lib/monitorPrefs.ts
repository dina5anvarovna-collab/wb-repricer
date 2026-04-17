import { env } from "../config/env.js";
import { getAppSetting, setAppSetting } from "./appSettings.js";
import { regionLabelForDest } from "./wbRegions.js";

const KEY_INTERVAL = "MONITOR_INTERVAL_HOURS";
const KEY_REGIONS = "SELECTED_REGION_DESTS";
const KEY_LAST_RUN = "MONITOR_LAST_TICK_AT";

function clampHours(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(168, Math.max(0.25, n));
}

/** Интервал планового мониторинга (часы), из настроек; по умолчанию 1. */
export async function getMonitorIntervalHours(): Promise<number> {
  const raw = (await getAppSetting(KEY_INTERVAL)).trim();
  const n = parseFloat(raw);
  const envFallback =
    typeof env.REPRICER_MONITOR_INTERVAL === "number" && Number.isFinite(env.REPRICER_MONITOR_INTERVAL)
      ? env.REPRICER_MONITOR_INTERVAL
      : 1;
  return clampHours(Number.isFinite(n) ? n : envFallback);
}

export async function setMonitorIntervalHours(hours: number): Promise<void> {
  await setAppSetting(KEY_INTERVAL, String(clampHours(hours)));
}

/** Выбранные dest регионов для парсинга витрины; если пусто — из REPRICER_WALLET_DEST. */
export async function getSelectedRegionDests(): Promise<string[]> {
  const raw = (await getAppSetting(KEY_REGIONS)).trim();
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr) && arr.length > 0) {
      return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
    }
  } catch {
    /* ignore */
  }
  const envDest = env.REPRICER_WALLET_DEST.trim();
  return envDest ? [envDest] : [];
}

export async function setSelectedRegionDests(dests: string[]): Promise<void> {
  const uniq = [...new Set(dests.map((d) => d.trim()).filter(Boolean))];
  await setAppSetting(KEY_REGIONS, JSON.stringify(uniq));
}

export async function getMonitorLastTickAt(): Promise<Date | null> {
  const raw = (await getAppSetting(KEY_LAST_RUN)).trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function setMonitorLastTickAt(d: Date): Promise<void> {
  await setAppSetting(KEY_LAST_RUN, d.toISOString());
}

/** Первый выбранный регион для защиты цен, если dest не передан явно. */
export async function getPrimaryWalletRegion(): Promise<{
  regionDest: string | null;
  regionLabel: string | null;
}> {
  const list = await getSelectedRegionDests();
  const dest = list[0] ?? null;
  if (!dest) {
    return { regionDest: null, regionLabel: null };
  }
  return { regionDest: dest, regionLabel: regionLabelForDest(dest) };
}
