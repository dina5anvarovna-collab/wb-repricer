import { describe, expect, it } from "vitest";
import { coerceQueryStringRecord } from "./httpQuery.js";

describe("coerceQueryStringRecord", () => {
  it("normalizes booleans and arrays", () => {
    expect(coerceQueryStringRecord({ a: true, b: false, c: ["x", "y"] })).toEqual({
      a: "true",
      b: "false",
      c: "x",
    });
  });

  it("drops empty strings so zod enums stay optional", () => {
    expect(coerceQueryStringRecord({ belowMin: "", stock: "  " })).toEqual({
      belowMin: undefined,
      stock: undefined,
    });
  });
});
