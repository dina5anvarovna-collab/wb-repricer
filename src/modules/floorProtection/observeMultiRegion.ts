/**
 * Multi-region observer для floor protection.
 *
 * Параллельно опрашивает card.wb.ru по всем dest-кластерам.
 * Возвращает minBuyerPriceRub = min(clientPriceRub across regions) — worst-case.
 *
 * Решение принимается только по минимальной цене: если хоть в одном
 * регионе покупатель видит цену ниже floor — инвариант нарушен.
 */

import { probeCardWb } from "../../lib/cardWbClient.js";
import { logger } from "../../lib/logger.js";
import { getDestClusters } from "./regions.js";
import type { MultiRegionObservation, RegionObservation } from "./types.js";

const TAG = "floor_observe";

export async function observeMultiRegion(
  nmId: number,
  destListOverride?: string,
): Promise<MultiRegionObservation> {
  const clusters = getDestClusters(destListOverride);
  const observedAt = new Date();

  // Параллельно запрашиваем все регионы
  const raw = await Promise.all(
    clusters.map(async ({ dest, label }): Promise<RegionObservation> => {
      const result = await probeCardWb(nmId, dest);
      if (result.clientPriceRub == null) {
        return {
          dest,
          label,
          clientPriceRub: null,
          basicPriceRub: null,
          ok: false,
          errorReason: `http_${result.httpStatus}_endpoint_${result.endpoint}`,
        };
      }
      return {
        dest,
        label,
        clientPriceRub: result.clientPriceRub,
        basicPriceRub: result.basicPriceRub,
        ok: true,
      };
    }),
  );

  const successful = raw.filter((r) => r.ok && r.clientPriceRub != null);

  if (successful.length === 0) {
    logger.warn({ tag: TAG, nmId, tried: clusters.length }, "все регионы вернули null clientPriceRub");
    return {
      ok: false,
      errorReason: "all_regions_failed",
      nmId,
      minBuyerPriceRub: null,
      worstCaseDest: null,
      worstCaseLabel: null,
      sellerEffectiveRub: null,
      allRegions: raw,
      observedAt,
    };
  }

  // Worst-case = регион с минимальной clientPriceRub
  const worstCase = successful.reduce((a, b) =>
    a.clientPriceRub! < b.clientPriceRub! ? a : b,
  );

  // sellerEffectiveRub берём из любого успешного ответа card.wb.ru
  // (salePriceU одинаков для всех регионов — определяется кабинетом)
  // Если недоступен — будет восстановлен из WB Seller API в floorEngine
  const probeForEff = await probeCardWb(nmId, worstCase.dest);
  const sellerEffectiveRub = probeForEff.sellerEffectiveRub;

  logger.info(
    {
      tag: TAG,
      nmId,
      regions: successful.length,
      minBuyerPriceRub: worstCase.clientPriceRub,
      worstCaseDest: worstCase.dest,
      worstCaseLabel: worstCase.label,
      sellerEffectiveRub,
    },
    "multi-region observation complete",
  );

  return {
    ok: true,
    nmId,
    minBuyerPriceRub: worstCase.clientPriceRub,
    worstCaseDest: worstCase.dest,
    worstCaseLabel: worstCase.label,
    sellerEffectiveRub,
    allRegions: raw,
    observedAt,
  };
}
