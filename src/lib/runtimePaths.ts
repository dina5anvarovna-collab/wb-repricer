import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

export const projectRoot = process.cwd();

function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
}

export const runtimePaths = {
  projectRoot,
  dataDir: abs(env.DATA_DIR),
  logDir: abs(env.LOG_DIR),
  tmpDir: abs(env.TMP_DIR),
  storageDir: abs(env.STORAGE_DIR),
  buyerProfileDir: abs(env.BUYER_PROFILE_DIR || env.REPRICER_BUYER_PROFILE_DIR),
  buyerStatePath: abs(env.BUYER_STATE_PATH || env.REPRICER_WB_STORAGE_STATE_PATH),
  webDistDir: abs(env.REPRICER_WEB_DIST_DIR),
  publicDir: abs(env.REPRICER_PUBLIC_DIR),
};

export function resolveProjectPath(p: string): string {
  return abs(p);
}

export function ensureRuntimeDirs(): void {
  const dirs = [
    runtimePaths.dataDir,
    runtimePaths.logDir,
    runtimePaths.tmpDir,
    runtimePaths.storageDir,
    runtimePaths.buyerProfileDir,
    path.dirname(runtimePaths.buyerStatePath),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

export function walletArtifactsDir(): string {
  return path.join(runtimePaths.storageDir, "artifacts", "wb-wallet");
}
