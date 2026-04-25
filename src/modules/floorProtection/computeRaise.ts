/**
 * Вычисление необходимого повышения basePrice в кабинете продавца.
 *
 * Подход: conservative K coefficient + buffer.
 *
 *   K_observed = 1 − minBuyerPriceRub / sellerEffectiveRub
 *   (суммарный дисконт WB: SPP + WB Кошелёк)
 *
 *   K_safe = K_observed + BUFFER
 *   (консервативная оценка: покрывает реакцию SPP при повышении цены)
 *
 *   effNeeded = floorPriceRub / (1 − K_safe)
 *   newBase   = ceil(effNeeded / (1 − sellerDiscountPct/100))
 *
 * Одно повышение закрывает все регионы: sellerEffective одинакова для всех,
 * K_wc — уже максимум (worst-case), поэтому остальные регионы с меньшим K
 * автоматически удовлетворят floor после того же повышения.
 */

import type { RaiseDecision } from "./types.js";

export type ComputeRaiseInput = {
  /** Минимальная buyer-цена (worst-case регион, с WB Кошельком), руб. */
  minBuyerPriceRub: number;
  /** Эффективная цена продавца (после его скидки, до SPP/Кошелька), руб. */
  sellerEffectiveRub: number;
  /** Текущий basePrice в кабинете продавца, руб. */
  currentBasePrice: number;
  /** Процент скидки продавца (0–99). */
  sellerDiscountPct: number;
  /** Абсолютный floor buyer-цены, установленный продавцом, руб. */
  floorPriceRub: number;
  /**
   * Дополнительный буфер к K_observed для покрытия реакции SPP.
   * Default: 0.05 (5 п.п.) — достаточно для большинства SPP-реакций WB.
   */
  bufferPct?: number;
  /**
   * Максимальный шаг повышения basePrice за один цикл, %.
   * Default: 30%.
   */
  maxStepPct?: number;
  /**
   * Абсолютный потолок basePrice (необязательно).
   * Если задан и requiredBase > absoluteMaxBase — action = "skip_capped".
   */
  absoluteMaxBase?: number;
};

export type ComputeRaiseOutput = RaiseDecision & {
  kObserved?: number;
  kSafe?: number;
  gapRub?: number;
  effNeeded?: number;
  requiredBase?: number;
};

/** Максимально допустимый суммарный дисконт WB. Защита от аномальных данных. */
const MAX_K = 0.75;

export function computeRaise(input: ComputeRaiseInput): ComputeRaiseOutput {
  const {
    minBuyerPriceRub,
    sellerEffectiveRub,
    currentBasePrice,
    sellerDiscountPct,
    floorPriceRub,
    bufferPct = 0.05,
    maxStepPct = 30,
    absoluteMaxBase,
  } = input;

  // 1. Инвариант уже выполнен?
  if (minBuyerPriceRub >= floorPriceRub) {
    return { action: "no_change", reason: "floor_satisfied" };
  }

  const gapRub = floorPriceRub - minBuyerPriceRub;

  // 2. Проверка данных
  if (sellerEffectiveRub <= 0 || !Number.isFinite(sellerEffectiveRub)) {
    return { action: "skip_no_data", reason: "invalid_seller_effective" };
  }
  if (minBuyerPriceRub <= 0 || !Number.isFinite(minBuyerPriceRub)) {
    return { action: "skip_no_data", reason: "invalid_buyer_price" };
  }

  // 3. K_observed = суммарный дисконт WB в worst-case регионе
  const kObserved = 1 - minBuyerPriceRub / sellerEffectiveRub;
  if (kObserved < 0 || !Number.isFinite(kObserved)) {
    // buyerPrice > sellerEffective — аномалия (акция, промо, другой механизм)
    return { action: "skip_no_data", reason: "k_observed_negative_anomaly" };
  }

  // 4. K_safe с буфером (консервативная оценка реакции SPP)
  const kSafe = Math.min(kObserved + bufferPct, MAX_K);

  // 5. Необходимый P_eff чтобы worst-case buyer >= floorPriceRub
  const effNeeded = floorPriceRub / (1 - kSafe);

  // 6. Необходимый basePrice (до скидки продавца)
  const discountFactor = 1 - sellerDiscountPct / 100;
  if (discountFactor <= 0) {
    return { action: "skip_no_data", reason: "invalid_seller_discount" };
  }
  const requiredBase = Math.ceil(effNeeded / discountFactor);

  // 7. Потолок: абсолютный maxBase
  if (absoluteMaxBase != null && requiredBase > absoluteMaxBase) {
    return {
      action: "skip_capped",
      reason: "exceeds_absolute_max_base",
      kObserved,
      kSafe,
      gapRub,
      effNeeded,
      requiredBase,
    };
  }

  // 8. Step cap: не более maxStepPct% за один цикл
  const maxAllowedBase = Math.ceil(currentBasePrice * (1 + maxStepPct / 100));

  if (requiredBase > maxAllowedBase) {
    // Полностью закрыть нарушение не получится за один шаг —
    // делаем максимально допустимый шаг, следующий цикл повторит.
    return {
      action: "raise_partial",
      newBase: maxAllowedBase,
      reason: "step_capped_partial_raise",
      kObserved,
      kSafe,
      gapRub,
      effNeeded,
      requiredBase,
    };
  }

  return {
    action: "raise_full",
    newBase: requiredBase,
    reason: "floor_will_be_satisfied",
    kObserved,
    kSafe,
    gapRub,
    effNeeded,
    requiredBase,
  };
}
