export type RepricingRegionInput = {
  dest: string;
  label: string;
  walletPriceRub: number | null;
  regularPriceRub: number | null;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | null;
  source: string | null;
};

export type RepricingDecision = "raise_price" | "no_change" | "insufficient_data";

export type RepricingStatus =
  | "enough_data"
  | "insufficient_data"
  | "ambiguity_warning";

export type RepricingSummary = {
  minWalletPriceRub: number | null;
  minWalletRegion: string | null;
  minNoWalletPriceRub: number | null;
  minNoWalletRegion: string | null;
  sellerMinPriceRub: number | null;
  repricingDecision: RepricingDecision;
  repricingStatus: RepricingStatus;
  repricingReason: string;
  recommendedCabinetPriceRub: number | null;
};

function isPositiveNumber(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

function normalizeRub(v: number | null | undefined): number | null {
  return isPositiveNumber(v) ? Math.round(v) : null;
}

function pickMinRow<T extends { value: number; label: string }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (a.value <= b.value ? a : b));
}

export function computeRepricingSummary(input: {
  regions: RepricingRegionInput[];
  sellerMinPriceRub: number | null;
  sellerCabinetPriceRub: number | null;
  safeModeRecommendationOnly: boolean;
}): RepricingSummary {
  const sellerMinPriceRub = normalizeRub(input.sellerMinPriceRub);
  const sellerCabinetPriceRub = normalizeRub(input.sellerCabinetPriceRub);
  const verifiedRegions = input.regions.filter((r) => r.verificationStatus === "VERIFIED");

  const walletRows = verifiedRegions
    .map((r) => ({
      value: normalizeRub(r.walletPriceRub),
      label: r.label?.trim() || r.dest?.trim() || null,
    }))
    .filter((r): r is { value: number; label: string | null } => r.value != null);
  const noWalletRows = verifiedRegions
    .map((r) => ({
      value: normalizeRub(r.regularPriceRub),
      label: r.label?.trim() || r.dest?.trim() || null,
    }))
    .filter((r): r is { value: number; label: string | null } => r.value != null);

  const minWallet = pickMinRow(walletRows.map((r) => ({ value: r.value, label: r.label ?? "—" })));
  const minNoWallet = pickMinRow(noWalletRows.map((r) => ({ value: r.value, label: r.label ?? "—" })));

  const minWalletPriceRub = minWallet?.value ?? null;
  const minWalletRegion = minWallet?.label ?? null;
  const minNoWalletPriceRub = minNoWallet?.value ?? null;
  const minNoWalletRegion = minNoWallet?.label ?? null;

  if (minWalletPriceRub == null || sellerMinPriceRub == null) {
    return {
      minWalletPriceRub,
      minWalletRegion,
      minNoWalletPriceRub,
      minNoWalletRegion,
      sellerMinPriceRub,
      repricingDecision: "insufficient_data",
      repricingStatus: "insufficient_data",
      repricingReason:
        minWalletPriceRub == null
          ? "Нет verified WB-кошелек цены по регионам"
          : "Не задано минимально допустимое значение Мин ₽",
      recommendedCabinetPriceRub: null,
    };
  }

  const hasUnverifiedRegions = input.regions.some((r) => r.verificationStatus === "UNVERIFIED");
  const decision: RepricingDecision =
    minWalletPriceRub < sellerMinPriceRub ? "raise_price" : "no_change";
  const delta = Math.max(0, sellerMinPriceRub - minWalletPriceRub);
  const recommendedCabinetPriceRub =
    decision === "raise_price"
      ? sellerCabinetPriceRub != null
        ? Math.round(sellerCabinetPriceRub + delta)
        : null
      : sellerCabinetPriceRub;

  const status: RepricingStatus = hasUnverifiedRegions ? "ambiguity_warning" : "enough_data";
  const reasonBase =
    decision === "raise_price"
      ? `Минимальный WB-кошелек ${minWalletPriceRub} ₽ ниже Мин ₽ ${sellerMinPriceRub} ₽`
      : `Минимальный WB-кошелек ${minWalletPriceRub} ₽ не ниже Мин ₽ ${sellerMinPriceRub} ₽`;
  const safeModeHint = input.safeModeRecommendationOnly
    ? "Режим safe-mode: только рекомендация, без записи цены в ЛК."
    : "Режим применения включён.";
  const ambiguityHint = hasUnverifiedRegions
    ? "Есть неполные/неподтвержденные регионы: решение может потребовать ручной проверки."
    : null;

  return {
    minWalletPriceRub,
    minWalletRegion,
    minNoWalletPriceRub,
    minNoWalletRegion,
    sellerMinPriceRub,
    repricingDecision: decision,
    repricingStatus: status,
    repricingReason: [reasonBase, ambiguityHint, safeModeHint].filter(Boolean).join(" "),
    recommendedCabinetPriceRub,
  };
}
