/**
 * Базовые URL официального Seller API и витрины (легко заменить при смене WB).
 * Cookie-запросы к личному кабинету — только через адаптер; публичные пути не гарантированы.
 */
export const WB_ENDPOINTS = {
  discountsPricesApi: "https://discounts-prices-api.wildberries.ru",
  contentApi: "https://content-api.wildberries.ru",
  /** Проверка «живости» браузерной сессии (витрина) */
  showcaseOrigin: "https://www.wildberries.ru",
  /** Точка входа кабинета продавца (для refresh профиля в браузере) */
  sellerPortal: "https://seller.wildberries.ru",
} as const;

export function wbPricesListGoodsFilterUrl(limit: number, offset: number): string {
  const u = new URL("/api/v2/list/goods/filter", WB_ENDPOINTS.discountsPricesApi);
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("offset", String(offset));
  return u.toString();
}
