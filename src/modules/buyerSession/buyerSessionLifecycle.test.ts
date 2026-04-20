import { describe, expect, it } from "vitest";
import {
  computeSessionStatus,
  updateSessionValidationResultSafe,
} from "./buyerSessionManager.js";

describe("buyer session lifecycle", () => {
  it("marks successful probe as fresh", () => {
    const status = computeSessionStatus({
      disabled: false,
      profileDirExists: true,
      storageStateExists: true,
      lastValidatedAt: new Date(),
      lastProbeOk: true,
    });
    expect(status).toBe("fresh");
  });

  it("marks ttl-expired probe as stale", () => {
    const status = computeSessionStatus({
      disabled: false,
      profileDirExists: true,
      storageStateExists: true,
      lastValidatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
      lastProbeOk: true,
      now: new Date(),
    });
    expect(status).toBe("stale");
  });

  it("marks missing storage state as invalid", () => {
    const status = computeSessionStatus({
      disabled: false,
      profileDirExists: true,
      storageStateExists: false,
      lastValidatedAt: new Date(),
      lastProbeOk: true,
    });
    expect(status).toBe("invalid");
  });

  it("marks disabled mode as disabled", () => {
    const status = computeSessionStatus({
      disabled: true,
      profileDirExists: true,
      storageStateExists: true,
      lastValidatedAt: new Date(),
      lastProbeOk: true,
    });
    expect(status).toBe("disabled");
  });

  it("returns not-fresh status when DB writer fails", async () => {
    const out = await updateSessionValidationResultSafe(
      {
        profileDir: "/tmp/wb",
        probeOk: true,
        probeReason: "probe_ok",
        hasDomAccess: true,
        hasCookieAccess: true,
        hasShowcaseAccess: true,
      },
      async () => {
        throw new Error("db_write_failed");
      },
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("invalid");
  });
});
