import type { WbProduct } from "@prisma/client";

/** Единый формат для API / UI / экспорта */
export type NormalizedWbProduct = {
  nmId: number;
  vendorCode: string | null;
  barcode: string | null;
  title: string;
  brand: string | null;
  category: string | null;
  price: number | null;
  discountedPrice: number | null;
  spp: number | null;
  stocksTotal: number | null;
  stocksByWarehouse: Array<{
    warehouseId: string | number;
    warehouseName: string;
    quantity: number;
  }>;
  updatedAt: string;
  raw: Record<string, unknown>;
};

function sppFromPrices(discounted: number | null | undefined, buyerFinal: number | null | undefined): number | null {
  if (
    discounted == null ||
    buyerFinal == null ||
    !Number.isFinite(discounted) ||
    !Number.isFinite(buyerFinal) ||
    discounted <= 0 ||
    buyerFinal <= 0
  ) {
    return null;
  }
  const pct = Math.round(1000 * (1 - buyerFinal / discounted)) / 10;
  return Number.isFinite(pct) && pct >= 0 ? pct : null;
}

export function normalizeWbProductFromDb(
  p: WbProduct,
  opts?: {
    buyerFinalRub?: number | null;
    stocksByWarehouse?: NormalizedWbProduct["stocksByWarehouse"];
  },
): NormalizedWbProduct {
  const stocksByWarehouse =
    opts?.stocksByWarehouse?.length ?
      opts.stocksByWarehouse
    : [
        {
          warehouseId: "total",
          warehouseName: "Всего (кабинет)",
          quantity: p.stock ?? 0,
        },
      ];
  const total =
    opts?.stocksByWarehouse?.reduce((s, w) => s + w.quantity, 0) ?? (p.stock ?? null);
  return {
    nmId: p.nmId,
    vendorCode: p.vendorCode ?? null,
    barcode: null,
    title: p.title,
    brand: p.brand ?? null,
    category: p.subjectName ?? null,
    price: p.sellerPrice ?? null,
    discountedPrice: p.discountedPriceRub ?? null,
    spp: sppFromPrices(p.discountedPriceRub ?? p.sellerPrice ?? null, opts?.buyerFinalRub ?? null),
    stocksTotal: total,
    stocksByWarehouse,
    updatedAt: p.updatedAt.toISOString(),
    raw: {
      id: p.id,
      cabinetId: p.cabinetId,
      isActive: p.isActive,
      lastMonitorAt: p.lastMonitorAt,
      lastWalletObservedRub: p.lastWalletObservedRub,
      lastRegularObservedRub: p.lastRegularObservedRub,
    },
  };
}
