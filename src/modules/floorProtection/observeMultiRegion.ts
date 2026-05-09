/**
 * Multi-region observer для floor protection.
 *
 * Параллельно опрашивает card.wb.ru по всем dest-кластерам.
 * Возвращает minBuyerPriceRub = min(clientPriceRub across regions) — worst-case.
 *
 * Решение принимается только по минимальной цене: если хоть в одном
 * регионе покупатель видит цену ниже floor — инвариант нарушен.
 *
 * sellerEffectiveRub берётся из первого успешного probe-ответа card.wb.ru.
 * salePriceU одинаков для всех регионов (определяется кабинетом, не складом).
 * Дополнительный запрос к Seller API НЕ выполняется.
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

  // Параллельно запрашиваем все регионы, сохраняем полный ответ probe
  const rawProbes = await Promise.all(
    clusters.map(async ({ dest, label }) => {
      const probe = await probeCardWb(nmId, dest);
      return { dest, label, probe };
    }),
  );

  // Формируем RegionObservation[]
  const raw: RegionObservation[] = rawProbes.map(({ dest, label, probe }) => {
    if (probe.clientPriceRub == null) {
      return {
        dest,
        label,
        clientPriceRub: null,
        basicPriceRub: null,
        ok: false,
        errorReason: `http_${probe.httpStatus}_endpoint_${probe.endpoint}`,
      };
    }
    return {
      dest,
      label,
      clientPriceRub: probe.clientPriceRub,
      basicPriceRub: probe.basicPriceRub,
      ok: true,
    };
  });

  // sellerEffectiveRub берём из первого успешного probe
  // (salePriceU одинаков для всех регионов — определяется скидкой продавца в кабинете)
  const sellerEffectiveRub =
    rawProbes.find((r) => r.probe.sellerEffectiveRub != null)?.probe.sellerEffectiveRub ?? null;

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
      sellerEffectiveRub,
      allRegions: raw,
      observedAt,
    };
  }

  // Worst-case = регион с минимальной clientPriceRub
  const worstCase = successful.reduce((a, b) =>
    a.clientPriceRub! < b.clientPriceRub! ? a : b,
  );

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
