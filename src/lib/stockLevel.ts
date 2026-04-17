export type StockLevel = "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN_STOCK";

/**
 * Остаток из кабинета (stock) + эвристика DOM (inStock).
 * OUT если кабинет = 0 или DOM явно «нет в наличии».
 */
export function resolveStockLevel(
  cabinetStock: number | null | undefined,
  domInStock: boolean | null | undefined,
): StockLevel {
  if (cabinetStock != null && Number.isFinite(cabinetStock) && cabinetStock <= 0) {
    return "OUT_OF_STOCK";
  }
  if (domInStock === false) {
    return "OUT_OF_STOCK";
  }
  if (cabinetStock != null && Number.isFinite(cabinetStock) && cabinetStock > 0) {
    return "IN_STOCK";
  }
  if (domInStock === true) {
    return "IN_STOCK";
  }
  return "UNKNOWN_STOCK";
}
