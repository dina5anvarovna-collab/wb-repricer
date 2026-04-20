import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function extractBearerToken(req: FastifyRequest): string | null {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, "")?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function hashAdminToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function createAdminSession(input: {
  ip: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashAdminToken(token);
  const expiresAt = new Date(Date.now() + env.REPRICER_ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000);
  await prisma.adminSession.create({
    data: {
      tokenHash,
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });
  return { token, expiresAt };
}

async function revokeAdminSession(token: string): Promise<void> {
  const tokenHash = hashAdminToken(token);
  await prisma.adminSession.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

async function isAdminSessionValid(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const tokenHash = hashAdminToken(token);
  const now = new Date();
  const row = await prisma.adminSession.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (!row) return false;
  await prisma.adminSession.update({
    where: { id: row.id },
    data: { lastUsedAt: now },
  });
  return true;
}

export function registerAdminAuth(app: FastifyInstance): void {
  const password = env.REPRICER_ADMIN_PASSWORD?.trim();
  app.post<{ Body: { password?: string } }>("/api/auth/login", async (req, reply) => {
    if (!password) {
      return reply.code(503).send({
        success: false,
        error: {
          code: "auth_not_configured",
          message: "Пароль панели не задан (REPRICER_ADMIN_PASSWORD).",
        },
      });
    }
    const p = req.body?.password ?? "";
    if (!safeCompare(p, password)) {
      return reply.code(401).send({
        success: false,
        error: { code: "unauthorized", message: "Неверный пароль" },
      });
    }
    const { token, expiresAt } = await createAdminSession({
      ip: req.ip ?? null,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    });
    return {
      success: true,
      data: {
        token,
        expiresInSec: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
      },
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const raw = extractBearerToken(req);
    if (raw) {
      await revokeAdminSession(raw);
    }
    return { success: true, data: { ok: true } };
  });

  app.post("/api/auth/revoke-current", async (req, reply) => {
    const raw = extractBearerToken(req);
    if (raw) {
      await revokeAdminSession(raw);
    }
    return { success: true, data: { ok: true } };
  });

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? req.url;
    const publicApi = url === "/api/auth/login" || url === "/api/health";
    if (!url.startsWith("/api/") || publicApi) {
      return;
    }
    if (!password) {
      return reply.code(503).send({
        success: false,
        error: {
          code: "auth_not_configured",
          message: "REPRICER_ADMIN_PASSWORD is required for protected API routes.",
        },
      });
    }
    const raw = extractBearerToken(req);
    if (!(await isAdminSessionValid(raw ?? undefined))) {
      return reply.code(401).send({
        success: false,
        error: {
          code: "unauthorized",
          message: "Требуется вход в панель (POST /api/auth/login)",
        },
      });
    }
  });
}
