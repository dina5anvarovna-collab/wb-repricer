import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

export type JobLockKind = "monitor" | "enforce" | "catalog";

const KINDS: JobLockKind[] = ["monitor", "enforce", "catalog"];

function lockTtlMs(): number {
  return env.REPRICER_SCHEDULER_LOCK_TTL_MIN * 60 * 1000;
}

/** Снимает истёкшие locks при старте процесса (после падения воркера без release). */
export async function cleanupExpiredSchedulerLocksOnStartup(): Promise<void> {
  const now = new Date();
  const legacySingleton = await prisma.schedulerLock.findUnique({
    where: { id: "singleton" },
  });
  if (legacySingleton?.lockedBy && legacySingleton.expiresAt != null && legacySingleton.expiresAt < now) {
    await prisma.schedulerLock.delete({ where: { id: "singleton" } }).catch(() => undefined);
    logger.warn({ tag: "scheduler-lock-migrate" }, "removed expired legacy singleton lock row");
  }

  for (const id of KINDS) {
    const row = await prisma.schedulerLock.findUnique({ where: { id } });
    if (!row?.lockedBy) continue;
    const expired = row.expiresAt != null && row.expiresAt < now;
    if (!expired) continue;
    await prisma.schedulerLock.update({
      where: { id },
      data: { lockedBy: null, lockedAt: null, expiresAt: null },
    });
    logger.warn(
      { lock: id, expiredHolder: row.lockedBy },
      "scheduler lock expired — stale holder cleared at startup",
    );
  }
}

function lockHolderProcessId(lockedBy: string | null | undefined): number | null {
  if (!lockedBy) return null;
  const m = /^(?:srv|api|cron)-(\d+)$/.exec(lockedBy);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function schedulerLockOwnerLabel(): string {
  return `srv-${process.pid}`;
}

/**
 * Захват lock для одного типа джобы (мониторинг / enforce / каталог — не блокируют друг друга).
 */
export async function acquireSchedulerLock(kind: JobLockKind = "monitor"): Promise<boolean> {
  const now = new Date();
  const expires = new Date(Date.now() + lockTtlMs());
  const owner = schedulerLockOwnerLabel();
  const row = await prisma.schedulerLock.findUnique({ where: { id: kind } });
  const holderPid = lockHolderProcessId(row?.lockedBy ?? null);
  if (row?.lockedBy && row.expiresAt && row.expiresAt >= now && holderPid === process.pid) {
    return false;
  }

  const tryClaim = async (): Promise<boolean> => {
    const claimed = await prisma.schedulerLock.updateMany({
      where: {
        id: kind,
        OR: [{ lockedBy: null }, { expiresAt: null }, { expiresAt: { lt: now } }],
      },
      data: { lockedBy: owner, lockedAt: now, expiresAt: expires },
    });
    return claimed.count === 1;
  };

  if (await tryClaim()) return true;

  await prisma.schedulerLock.upsert({
    where: { id: kind },
    create: { id: kind, lockedBy: owner, lockedAt: now, expiresAt: expires },
    update: {},
  });

  const afterUpsert = await prisma.schedulerLock.findUnique({ where: { id: kind } });
  if (afterUpsert?.lockedBy === owner) return true;

  return tryClaim();
}

export async function releaseSchedulerLock(kind: JobLockKind = "monitor"): Promise<void> {
  await prisma.schedulerLock.updateMany({
    where: { id: kind, lockedBy: schedulerLockOwnerLabel() },
    data: { lockedBy: null, lockedAt: null, expiresAt: null },
  });
}
