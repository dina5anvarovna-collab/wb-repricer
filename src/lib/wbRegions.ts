import fs from "node:fs";
import path from "node:path";

export type WbRegionRow = {
  id: string;
  name: string;
  dest: string;
};

let cache: WbRegionRow[] | null = null;

/** Справочник регионов витрины WB (query `dest` на карточке товара). */
export function loadWbRegions(): WbRegionRow[] {
  if (cache) {
    return cache;
  }
  const p = path.resolve(process.cwd(), "data", "wb-regions.json");
  if (!fs.existsSync(p)) {
    cache = [];
    return cache;
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    cache = [];
    return cache;
  }
  cache = raw
    .map((x) => {
      if (!x || typeof x !== "object") {
        return null;
      }
      const o = x as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : "";
      const name = typeof o.name === "string" ? o.name : "";
      const dest = typeof o.dest === "string" ? o.dest : "";
      if (!dest) {
        return null;
      }
      return { id: id || dest, name: name || dest, dest };
    })
    .filter((x): x is WbRegionRow => x != null);
  return cache;
}

export function regionLabelForDest(dest: string | null | undefined): string | null {
  const d = dest?.trim();
  if (!d) {
    return null;
  }
  const row = loadWbRegions().find((r) => r.dest === d);
  return row?.name ?? null;
}
