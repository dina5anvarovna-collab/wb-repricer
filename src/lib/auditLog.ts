import { prisma } from "./prisma.js";

export async function writeAuditLog(opts: {
  actor?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  dryRun?: boolean;
  requestJson?: unknown;
  responseJson?: unknown;
  meta?: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor: opts.actor ?? "system",
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId ?? null,
      dryRun: opts.dryRun ?? false,
      requestJson: opts.requestJson != null ? JSON.stringify(opts.requestJson).slice(0, 8000) : null,
      responseJson: opts.responseJson != null ? JSON.stringify(opts.responseJson).slice(0, 8000) : null,
      metaJson: opts.meta != null ? JSON.stringify(opts.meta).slice(0, 8000) : null,
    },
  });
}
