/**
 * WB Basket-кластеры для multi-region floor protection.
 *
 * WB группирует все адреса доставки в ~8–10 кластеров по складам.
 * Внутри одного кластера clientPriceU одинаков.
 * Достаточно одного dest на кластер для покрытия worst-case.
 *
 * Переопределить через REPRICER_FLOOR_DEST_LIST (JSON-массив):
 *   [{"dest":"-1257786","label":"Москва"},...]
 */

export type DestCluster = {
  dest: string;
  label: string;
};

/** Дефолтные кластеры: 6 основных складских зон WB. */
export const DEFAULT_DEST_CLUSTERS: DestCluster[] = [
  { dest: "-1257786", label: "Москва/МО"       },
  { dest: "-2133459", label: "Санкт-Петербург"  },
  { dest: "-5551776", label: "Екатеринбург"     },
  { dest: "-4106026", label: "Новосибирск"      },
  { dest: "-1861391", label: "Краснодар"        },
  { dest: "-2956208", label: "Казань"           },
];

/**
 * Возвращает список dest-кластеров для мониторинга.
 * Если REPRICER_FLOOR_DEST_LIST задан — использует его.
 */
export function getDestClusters(envOverride?: string): DestCluster[] {
  const raw = envOverride?.trim();
  if (!raw) return DEFAULT_DEST_CLUSTERS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (x) =>
          x &&
          typeof x === "object" &&
          typeof (x as Record<string, unknown>).dest === "string",
      )
    ) {
      return parsed as DestCluster[];
    }
  } catch {
    // fallback to defaults
  }
  return DEFAULT_DEST_CLUSTERS;
}
