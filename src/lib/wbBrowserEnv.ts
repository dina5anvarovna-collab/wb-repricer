import { env } from "../config/env.js";

function envTruthy(s: string): boolean {
  const v = s.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Headless для мониторинга и wallet CLI; `WB_BROWSER_HEADLESS` перекрывает `HEADLESS`. */
export function resolveWbBrowserHeadless(): boolean {
  const w = env.WB_BROWSER_HEADLESS.trim();
  if (w.length > 0) {
    return envTruthy(w);
  }
  return envTruthy(env.HEADLESS);
}
