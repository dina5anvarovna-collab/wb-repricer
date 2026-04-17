import { describe, expect, it } from "vitest";
import {
  parseShowcaseRubFromCardDetailJson,
  parseShowcaseRubFromCardDetailJsonOrNested,
  parseWalletRubFromCardDetailJson,
  parseWalletRubFromCardDetailJsonOrNested,
} from "./buyerShowcaseCardRequest.js";

describe("parseShowcaseRubFromCardDetailJson", () => {
  it("reads product price from data.products", () => {
    const nmId = 123;
    const j = {
      data: {
        products: [
          {
            id: nmId,
            sizes: [{ price: { product: 199900, total: 199900 } }],
          },
        ],
      },
    };
    expect(parseShowcaseRubFromCardDetailJson(j, nmId)).toBe(1999);
  });

  it("falls back to first product when id mismatch", () => {
    const j = {
      products: [
        {
          id: 999,
          sizes: [{ price: { product: 50000 } }],
        },
      ],
    };
    expect(parseShowcaseRubFromCardDetailJson(j, 123)).toBe(500);
  });

  it("reads salePriceU on product root", () => {
    const j = {
      data: {
        products: [{ id: 1, salePriceU: 1_234_00, sizes: [] }],
      },
    };
    expect(parseShowcaseRubFromCardDetailJson(j, 1)).toBe(1234);
  });
});

describe("parseShowcaseRubFromCardDetailJsonOrNested", () => {
  it("finds product nested outside data.products", () => {
    const nmId = 929989896;
    const j = {
      state: {
        catalog: {
          item: {
            id: nmId,
            salePriceU: 88_800,
            sizes: [],
          },
        },
      },
    };
    expect(parseShowcaseRubFromCardDetailJsonOrNested(j, nmId)).toBe(888);
  });
});

describe("parseWalletRubFromCardDetailJson", () => {
  it("reads walletPrice from sizes[].price when lower than product", () => {
    const nmId = 555;
    const j = {
      data: {
        products: [
          {
            id: nmId,
            sizes: [
              {
                price: {
                  product: 200000,
                  total: 200000,
                  walletPrice: 175000,
                },
              },
            ],
          },
        ],
      },
    };
    expect(parseWalletRubFromCardDetailJson(j, nmId)).toBe(1750);
  });

  it("returns null when JSON has no wallet fields", () => {
    const nmId = 1;
    const j = {
      data: {
        products: [{ id: nmId, sizes: [{ price: { product: 99900, total: 99900 } }] }],
      },
    };
    expect(parseWalletRubFromCardDetailJson(j, nmId)).toBeNull();
  });
});

describe("parseWalletRubFromCardDetailJsonOrNested", () => {
  it("finds wallet in nested product by nmId", () => {
    const nmId = 42;
    const j = {
      payload: {
        products: [
          {
            id: nmId,
            sizes: [{ price: { product: 100000, walletPrice: 88800 } }],
          },
        ],
      },
    };
    expect(parseWalletRubFromCardDetailJsonOrNested(j, nmId)).toBe(888);
  });
});
