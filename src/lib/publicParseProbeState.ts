import type { PublicParseBlockReason } from "./publicParseBlockReason.js";

export type PublicProbeSnapshot = {
  at: string;
  nmId: number | null;
  ok: boolean;
  parseStatus: string | null;
  blockReason: PublicParseBlockReason | null;
  priceParseSource: string | null;
  confidence: number | null;
  browserUrlAfterParse: string | null;
  pageTitle: string | null;
  attemptCount: number;
  debugArtifactPaths: string[];
};

let lastProbe: PublicProbeSnapshot | null = null;

export function recordPublicParseProbe(r: PublicProbeSnapshot): void {
  lastProbe = r;
}

export function getLastPublicParseProbe(): PublicProbeSnapshot | null {
  return lastProbe;
}
