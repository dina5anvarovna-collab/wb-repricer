import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const createdDirs = new Set<string>();

/**
 * Временный каталог user-data Chromium без buyer login (PUBLIC ONLY).
 * Один каталог на прогон мониторинга; удалить после batch.
 */
export function createEphemeralWalletProfileDir(): string {
  const tmp = path.isAbsolute(env.TMP_DIR) ? env.TMP_DIR : path.resolve(process.cwd(), env.TMP_DIR);
  const dir = path.join(tmp, `wb-wallet-public-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  createdDirs.add(dir);
  return dir;
}

export function removeEphemeralWalletProfileDir(dir: string): void {
  if (!createdDirs.has(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  createdDirs.delete(dir);
}

/** Для unit-тестов / освобождения при аварийном выходе */
export function tmpDirRoot(): string {
  return path.isAbsolute(env.TMP_DIR) ? env.TMP_DIR : path.resolve(process.cwd(), env.TMP_DIR);
}
