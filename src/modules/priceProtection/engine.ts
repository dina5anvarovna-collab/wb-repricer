/**
 * Движок защиты минимальной итоговой цены.
 * В режиме enforcementMode итог для сравнения с минимумом — только цена WB Кошелька
 * (при достаточной уверенности парсинга), без подмены обычной витринной ценой.
 */

import { ReasonCode } from "./reasonCodes.js";

export type RoundingMode =
  | "integer"
  | "tens"
  | "end9"
  | "end49"
  | "end90"
  | "end99";

export type ProtectionEngineInput = {
  minAllowedFinalPrice: number;
  currentBasePrice: number;
  currentDiscountPercent: number;
  /** Приоритет: кошелёк/DOM > цена после скидки > база */
  observedWalletPrice: number | null;
  observedDiscountedPrice: number | null;
  safetyBufferPercent: number;
  roundingMode: RoundingMode;
  maxIncreasePercentPerCycle: number;
  maxIncreaseAbsolute: number;
  minChangeThreshold: number;
  /** Уже прошло минут с lastSuccessfulRaise */
  minutesSinceLastRaise: number | null;
  cooldownMinutes: number;
  /** Допуск к минимуму (₽): итог считается «в норме», если >= min − tolerance */
  priceToleranceRub: number;
  /**
   * Если true — для оценки «ниже минимума» и расчёта подъёма используем только observedWalletPrice
   * (не подставляем цену со скидкой / базу как «итог для покупателя»).
   */
  enforcementMode?: boolean;
  /** Уверенность парсинга кошелька 0..1; в enforcementMode ниже порога — пропуск выгрузки */
  walletParseConfidence?: number | null;
  minWalletConfidence?: number;
};

export type ProtectionEngineResult = {
  action: "no_change" | "skip" | "propose";
  newBasePrice: number | null;
  expectedFinalPrice: number | null;
  observedFinalPrice: number;
  ratio: number;
  reason: string;
  reasonCode: string;
  /** Читаемая строка с формулой (для логов и UI) */
  formulaLog?: string;
  safetyFlags: string[];
};

/** Итоговая «цена для покупателя» по правилам спецификации */
export function pickObservedFinalPrice(input: {
  observedWalletPrice: number | null;
  observedDiscountedPrice: number | null;
  currentBasePrice: number;
  currentDiscountPercent: number;
}): { final: number; source: "wallet" | "discounted" | "computed_discount" | "base" } {
  if (
    input.observedWalletPrice != null &&
    Number.isFinite(input.observedWalletPrice) &&
    input.observedWalletPrice > 0
  ) {
    return { final: input.observedWalletPrice, source: "wallet" };
  }
  if (
    input.observedDiscountedPrice != null &&
    Number.isFinite(input.observedDiscountedPrice) &&
    input.observedDiscountedPrice > 0
  ) {
    return { final: input.observedDiscountedPrice, source: "discounted" };
  }
  const d = input.currentDiscountPercent;
  if (
    Number.isFinite(input.currentBasePrice) &&
    input.currentBasePrice > 0 &&
    Number.isFinite(d) &&
    d > 0 &&
    d < 100
  ) {
    return {
      final: Math.round(input.currentBasePrice * (100 - d) / 100),
      source: "computed_discount",
    };
  }
  return { final: Math.max(0, input.currentBasePrice), source: "base" };
}

export function applyRounding(price: number, mode: RoundingMode): number {
  const p = Math.max(1, Math.ceil(price));
  switch (mode) {
    case "integer":
      return p;
    case "tens":
      return Math.max(10, Math.ceil(p / 10) * 10);
    case "end9": {
      if (p <= 9) return 9;
      return Math.ceil((p - 9) / 10) * 10 + 9;
    }
    case "end49": {
      if (p <= 49) return 49;
      return Math.ceil((p - 49) / 100) * 100 + 49;
    }
    case "end90": {
      if (p <= 90) return 90;
      return Math.ceil((p - 90) / 100) * 100 + 90;
    }
    case "end99": {
      if (p <= 99) return 99;
      return Math.ceil((p - 99) / 100) * 100 + 99;
    }
    default:
      return p;
  }
}

export function computeProtectionRaise(input: ProtectionEngineInput): ProtectionEngineResult {
  const flags: string[] = [];
  const base = input.currentBasePrice;
  const enforcement = input.enforcementMode === true;
  const minConf =
    typeof input.minWalletConfidence === "number" && Number.isFinite(input.minWalletConfidence)
      ? Math.max(0, Math.min(1, input.minWalletConfidence))
      : 0.5;
  const conf =
    input.walletParseConfidence != null && Number.isFinite(input.walletParseConfidence)
      ? input.walletParseConfidence
      : null;

  const picked = pickObservedFinalPrice({
    observedWalletPrice: input.observedWalletPrice,
    observedDiscountedPrice: input.observedDiscountedPrice,
    currentBasePrice: base,
    currentDiscountPercent: input.currentDiscountPercent,
  });

  let observedFinal = picked.final;
  let source = picked.source;

  if (enforcement) {
    const w = input.observedWalletPrice;
    if (w == null || !Number.isFinite(w) || w <= 0) {
      return {
        action: "skip",
        newBasePrice: null,
        expectedFinalPrice: null,
        observedFinalPrice: 0,
        ratio: 0,
        reason:
          "Режим удержания: нет явной цены WB Кошелька на витрине — выгрузка не выполняется (не подставляем обычную цену).",
        reasonCode: ReasonCode.SKIPPED_NO_WALLET,
        safetyFlags: ["enforcement_wallet_required"],
      };
    }
    if (conf != null && conf < minConf) {
      return {
        action: "skip",
        newBasePrice: null,
        expectedFinalPrice: null,
        observedFinalPrice: w,
        ratio: w / (Number.isFinite(base) && base > 0 ? base : 1),
        reason: `Низкая уверенность парсинга кошелька (${(conf * 100).toFixed(0)}% < ${(minConf * 100).toFixed(0)}%) — пропуск реальной выгрузки.`,
        reasonCode: ReasonCode.SKIPPED_LOW_CONFIDENCE,
        formulaLog: `confidence=${conf.toFixed(3)}, min=${minConf.toFixed(3)}`,
        safetyFlags: ["low_wallet_confidence"],
      };
    }
    observedFinal = w;
    source = "wallet";
  }

  if (!Number.isFinite(base) || base <= 0) {
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: null,
      observedFinalPrice: observedFinal,
      ratio: 0,
      reason: "Нет корректной базовой цены в кабинете",
      reasonCode: ReasonCode.SKIPPED_NO_BASE_PRICE,
      safetyFlags: ["no_base_price"],
    };
  }

  if (!Number.isFinite(observedFinal) || observedFinal <= 0) {
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: null,
      observedFinalPrice: observedFinal,
      ratio: 0,
      reason: enforcement
        ? "Нет цены кошелька для сравнения с минимумом"
        : "Нет наблюдаемой итоговой цены (нужен парсинг кошелька или скидка в кабинете)",
      reasonCode: ReasonCode.SKIPPED_NO_OBSERVED_FINAL,
      safetyFlags: ["no_observed_final"],
    };
  }

  const ratio = observedFinal / base;
  if (ratio <= 0 || ratio > 1.5) {
    flags.push("anomalous_ratio");
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: null,
      observedFinalPrice: observedFinal,
      ratio,
      reason: `Аномальный коэффициент итог/база (${ratio.toFixed(4)}), пропуск для безопасности`,
      reasonCode: ReasonCode.SKIPPED_ANOMALOUS_RATIO,
      formulaLog: `ratio=observedFinal/base=${observedFinal}/${base}`,
      safetyFlags: flags,
    };
  }

  const tol = Math.max(0, input.priceToleranceRub);
  if (observedFinal >= input.minAllowedFinalPrice - tol) {
    return {
      action: "no_change",
      newBasePrice: null,
      expectedFinalPrice: observedFinal,
      observedFinalPrice: observedFinal,
      ratio,
      reason: `Итоговая цена в норме (источник: ${source})`,
      reasonCode: ReasonCode.TARGET_MET,
      formulaLog: `observedFinal=${observedFinal} >= min−tol=${input.minAllowedFinalPrice}−${tol}`,
      safetyFlags: [],
    };
  }

  if (
    input.minutesSinceLastRaise != null &&
    input.minutesSinceLastRaise < input.cooldownMinutes
  ) {
    flags.push("cooldown");
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: null,
      observedFinalPrice: observedFinal,
      ratio,
      reason: `Cooldown: последнее повышение ${input.minutesSinceLastRaise} мин назад (< ${input.cooldownMinutes} мин)`,
      reasonCode: ReasonCode.SKIPPED_COOLDOWN,
      safetyFlags: flags,
    };
  }

  const minRequiredFinal = input.minAllowedFinalPrice - tol;
  let rawNewBase = input.minAllowedFinalPrice / ratio;
  rawNewBase *= 1 + input.safetyBufferPercent / 100;
  let newBase = applyRounding(rawNewBase, input.roundingMode);
  newBase = Math.max(1, newBase);

  const formulaBase = `rawBase = ceilRound( (min/ratio) * (1 + buffer%) ) = (${input.minAllowedFinalPrice}/${ratio.toFixed(6)}) * (1 + ${input.safetyBufferPercent}%) → ${rawNewBase.toFixed(2)} → rounded ${newBase}`;

  const lowCap = Math.max(1, Math.floor(base * (1 - input.maxIncreasePercentPerCycle / 100)));
  const highCap = Math.ceil(base * (1 + input.maxIncreasePercentPerCycle / 100));
  const absCap = base + input.maxIncreaseAbsolute;
  const cappedHigh = Math.min(highCap, absCap);
  if (newBase < lowCap) {
    flags.push("clamped_low");
    newBase = lowCap;
  }
  if (newBase > cappedHigh) {
    flags.push("clamped_high");
    newBase = cappedHigh;
  }

  const expectedFinal = newBase * ratio;
  if (expectedFinal < minRequiredFinal) {
    flags.push("cannot_reach_min");
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: expectedFinal,
      observedFinalPrice: observedFinal,
      ratio,
      reason: "После округления/лимитов невозможно достичь минимальной цены в этом цикле",
      reasonCode: ReasonCode.SKIPPED_CANNOT_REACH_MIN,
      formulaLog: `${formulaBase}; caps: low=${lowCap}, high=${cappedHigh}; minRequiredFinal=${minRequiredFinal}`,
      safetyFlags: flags,
    };
  }
  if (newBase <= base) {
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: expectedFinal,
      observedFinalPrice: observedFinal,
      ratio,
      reason: "После лимитов новая база не выше текущей — пропуск",
      reasonCode: ReasonCode.SKIPPED_CLAMPED_NO_GAIN,
      formulaLog: `${formulaBase}; caps: low=${lowCap}, high=${cappedHigh}`,
      safetyFlags: flags,
    };
  }

  if (newBase - base < input.minChangeThreshold) {
    flags.push("below_min_change");
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: expectedFinal,
      observedFinalPrice: observedFinal,
      ratio,
      reason: `Изменение базы ${newBase - base} ₽ < порога ${input.minChangeThreshold} ₽`,
      reasonCode: ReasonCode.SKIPPED_BELOW_MIN_CHANGE,
      formulaLog: formulaBase,
      safetyFlags: flags,
    };
  }

  const quarantineFloor = Math.max(1, Math.floor(base / 3) + 1);
  if (newBase < quarantineFloor && newBase < base) {
    flags.push("quarantine_risk");
    return {
      action: "skip",
      newBasePrice: null,
      expectedFinalPrice: null,
      observedFinalPrice: observedFinal,
      ratio,
      reason: `Риск карантина WB: расчётная база ${newBase} < безопасного пола ~${quarantineFloor}`,
      reasonCode: ReasonCode.SKIPPED_QUARANTINE_RISK,
      formulaLog: formulaBase,
      safetyFlags: flags,
    };
  }

  return {
    action: "propose",
    newBasePrice: newBase,
    expectedFinalPrice: expectedFinal,
    observedFinalPrice: observedFinal,
    ratio,
    reason: `Кошелёк ниже min: подъём базы; коэфф. ${ratio.toFixed(4)}, буфер ${input.safetyBufferPercent}%`,
    reasonCode: ReasonCode.BELOW_MIN_RAISE_PROPOSED,
    formulaLog: `${formulaBase}; expectedFinal≈${expectedFinal.toFixed(0)}`,
    safetyFlags: flags,
  };
}
