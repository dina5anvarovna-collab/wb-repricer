import { describe, expect, it } from "vitest";
import { shouldBlockAutoApplyByBuyerVerification } from "./runEnforcementJob.js";

describe("enforcement verification gate", () => {
  it("blocks auto apply when buyer snapshot is not VERIFIED", () => {
    expect(
      shouldBlockAutoApplyByBuyerVerification({
        verificationStatus: "UNVERIFIED",
      }),
    ).toBe(true);
  });
});

