import { prisma } from "./prisma.js";

const DEFAULTS: Record<string, string> = {
  GLOBAL_PAUSE: "false",
  EMERGENCY_STOP: "false",
  MONITOR_INTERVAL_HOURS: "1",
  SELECTED_REGION_DESTS: "[]",
  MONITOR_LAST_TICK_AT: "",
};

export async function getAppSetting(key: string): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (row) {
    return row.value;
  }
  return DEFAULTS[key] ?? "";
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function isGlobalPaused(): Promise<boolean> {
  const v = (await getAppSetting("GLOBAL_PAUSE")).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function isEmergencyStop(): Promise<boolean> {
  const v = (await getAppSetting("EMERGENCY_STOP")).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
