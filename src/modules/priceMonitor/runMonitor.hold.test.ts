import { describe, expect, it } from "vitest";
import { classifyMonitorHoldState, shouldSkipOverwriteLastGood } from "./runMonitor.js";

describe("monitor hold classification", () => {
  it("detects captcha hold and skips update", () => {
    const r = classifyMonitorHoldState({
      parseStatus: "blocked_or_captcha",
      httpStatus: 498,
      validation: "fresh",
    });
    expect(r.captcha).toBe(true);
    expect(r.skipUpdate).toBe(true);
    expect(r.reason).toBe("captcha_hold");
  });

  it("detects stale hold and skips update", () => {
    const r = classifyMonitorHoldState({
      parseStatus: "auth_required",
      httpStatus: null,
      validation: "stale",
    });
    expect(r.stale).toBe(true);
    expect(r.skipUpdate).toBe(true);
    expect(r.reason).toBe("stale_hold");
  });

  it("prevents overwriting last good with null buyer values", () => {
    expect(
      shouldSkipOverwriteLastGood({
        walletRub: null,
        nonWalletRub: null,
      }),
    ).toBe(true);
  });
});

