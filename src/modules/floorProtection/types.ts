/**
 * Типы для Floor Protection Engine.
 *
 * Задача: гарантировать что цена покупателя (clientPriceU, включая SPP + WB Кошелёк)
 * никогда не опускается ниже floorPriceRub, установленного продавцом.
 *
 * Это constraint problem, не optimization: единственный инвариант —
 *   min(clientPriceRub across monitored dests) >= floorPriceRub
 */

/** Результат наблюдения одного региона. */
export type RegionObservation = {
  dest: string;
  label: string;
  clientPriceRub: number | null;   // цена покупателя с WB Кошельком
  basicPriceRub: number | null;    // цена без WB Кошелька (с SPP)
  ok: boolean;
  errorReason?: string;
};

/** Агрегированный результат multi-region наблюдения. */
export type MultiRegionObservation = {
  ok: boolean;
  errorReason?: string;
  nmId: number;
  /** Минимальная buyer-цена среди всех наблюдаемых регионов (worst-case). */
  minBuyerPriceRub: number | null;
  worstCaseDest: string | null;
  worstCaseLabel: string | null;
  /** Эффективная цена продавца (из Seller API). */
  sellerEffectiveRub: number | null;
  allRegions: RegionObservation[];
  observedAt: Date;
};

/** Решение движка: что делать с ценой в кабинете. */
export type RaiseDecision =
  | { action: "no_change";      reason: string }
  | { action: "raise_full";     newBase: number; reason: string; kObserved: number; kSafe: number; gapRub: number }
  | { action: "raise_partial";  newBase: number; reason: string; kObserved: number; kSafe: number; gapRub: number }
  | { action: "skip_no_data";   reason: string }
  | { action: "skip_capped";    reason: string };  // достигнут абсолютный потолок basePrice

/** Статус одного прогона движка для одного SKU. */
export type FloorEngineRunResult = {
  nmId: number;
  productId: string;
  floorPriceRub: number;
  observation: MultiRegionObservation;
  decision: RaiseDecision;
  uploadedBase?: number;
  uploadedAt?: Date;
  dryRun: boolean;
  postVerify?: {
    minBuyerPriceRub: number | null;
    satisfied: boolean;
    verifiedAt: Date;
  };
};

/** Конфигурация floor protection для одного SKU (из MinPriceRule). */
export type SkuFloorConfig = {
  productId: string;
  nmId: number;
  floorPriceRub: number;       // minAllowedFinalPrice
  enabled: boolean;            // controlEnabled
  maxStepPercent: number;      // maxIncreasePercentPerCycle
  cooldownMinutes: number;     // cooldownMinutes
  lastSuccessfulRaiseAt: Date | null;
};
