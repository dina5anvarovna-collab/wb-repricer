import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

const LOCK_ID = "singleton";

function lockTtlMs(): number {
  return env.REPRICER_SCHEDULER_LOCK_TTL_MIN * 60 * 1000;
}

/** Снимает истёкший lock при старте процесса (после падения воркера без release). */
export async function cleanupExpiredSchedulerLocksOnStartup(): Promise<void> {
  const now = new Date();
  const row = await prisma.schedulerLock.findUnique({ where: { id: LOCK_ID } });
  if (!row?.lockedBy) return;
  const expired = row.expiresAt != null && row.expiresAt < now;
  if (!expired) return;
  await prisma.schedulerLock.update({
    where: { id: LOCK_ID },
    data: { lockedBy: null, lockedAt: null, expiresAt: null },
  });
  logger.warn(
    {
      expiredHolder: row.lockedBy,
      expiredAt: row.expiresAt?.toISOString() ?? null,
    },
    "monitor job lock expired and recovered — stale holder cleared at startup",
  );
}

/**
 * Извлекает PID из старых записей lock: api-12345, cron-12345, srv-12345.
 * Разные префиксы в одном процессе больше не должны блокировать друг друга.
 */
function lockHolderProcessId(lockedBy: string | null | undefined): number | null {
  if (!lockedBy) return null;
  const m = /^(?:srv|api|cron)-(\d+)$/.exec(lockedBy);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Метка владельца в БД (одна на процесс сервера) */
export function schedulerLockOwnerLabel(): string {
  return `srv-${process.pid}`;
}

/**
 * Захват глобальной блокировки джоб (мониторинг / enforce).
 * Захват выполняется атомарно: только если lock свободен или истёк.
 * Активный lock другого процесса не перезаписывается.
 */
export async function acquireSchedulerLock(): Promise<boolean> {
  const now = new Date();
  const expires = new Date(Date.now() + lockTtlMs());
  const owner = schedulerLockOwnerLabel();
  const row = await prisma.schedulerLock.findUnique({ where: { id: LOCK_ID } });
  const holderPid = lockHolderProcessId(row?.lockedBy ?? null);
  if (row?.lockedBy && row.expiresAt && row.expiresAt >= now && holderPid === process.pid) {
    return false;
  }

  const tryClaim = async (): Promise<boolean> => {
    const claimed = await prisma.schedulerLock.updateMany({
      where: {
        id: LOCK_ID,
        OR: [
          { lockedBy: null },
          { expiresAt: null },
          { expiresAt: { lt: now } },
        ],
      },
      data: { lockedBy: owner, lockedAt: now, expiresAt: expires },
    });
    return claimed.count === 1;
  };

  if (await tryClaim()) return true;

  await prisma.schedulerLock.upsert({
    where: { id: LOCK_ID },
    create: { id: LOCK_ID, lockedBy: owner, lockedAt: now, expiresAt: expires },
    // Если строка уже есть — ничего не меняем здесь, чтобы не перехватить lock у другого процесса.
    update: {},
  });

  // Если upsert создал строку под этим owner — lock уже наш.
  const afterUpsert = await prisma.schedulerLock.findUnique({ where: { id: LOCK_ID } });
  if (afterUpsert?.lockedBy === owner) {
    return true;
  }

  return tryClaim();
}

/** Снимает lock, если его держит текущий процесс */
export async function releaseSchedulerLock(): Promise<void> {
  await prisma.schedulerLock.updateMany({
    where: { id: LOCK_ID, lockedBy: schedulerLockOwnerLabel() },
    data: { lockedBy: null, lockedAt: null, expiresAt: null },
  });
}
