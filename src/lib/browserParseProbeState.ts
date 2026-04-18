import type { PublicParseBlockReason } from "./publicParseBlockReason.js";

export type BrowserParseProbeSnapshot = {
  at: string;
  nmId: number | null;
  ok: boolean;
  parseStatus: string | null;
  blockReason: PublicParseBlockReason | null;
  priceParseSource: string | null;
  confidence: number | null;
  browserUrlAfterParse: string | null;
  pageTitle: string | null;
  monitorParseContour: "browser_primary" | "browser_retry" | "public_fallback" | null;
  debugArtifactPaths: string[];
};

let lastProbe: BrowserParseProbeSnapshot | null = null;

export function recordBrowserParseProbe(r: BrowserParseProbeSnapshot): void {
  lastProbe = r;
}

export function getLastBrowserParseProbe(): BrowserParseProbeSnapshot | null {
  return lastProbe;
}
