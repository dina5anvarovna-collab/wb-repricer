import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

const sessions = new Set<string>();

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function issueAdminSession(): string {
  const t = randomBytes(32).toString("hex");
  sessions.add(t);
  return t;
}

export function revokeAdminSession(token: string): void {
  sessions.delete(token);
}

export function isAdminSessionValid(token: string | undefined): boolean {
  if (!token) return false;
  return sessions.has(token);
}

export function registerAdminAuth(app: FastifyInstance): void {
  const password = env.REPRICER_ADMIN_PASSWORD?.trim();
  if (!password) {
    /** Явный ответ вместо 404: фронт не «теряет» сервер при открытой странице /login. */
    app.post("/api/auth/login", async (_req, reply) => {
      return reply.code(400).send({
        success: false,
        error: {
          code: "auth_disabled",
          message:
            "Пароль панели не задан (REPRICER_ADMIN_PASSWORD пустой). Вход не нужен — перейдите на главную.",
        },
      });
    });
    return;
  }

  app.post<{ Body: { password?: string } }>("/api/auth/login", async (req, reply) => {
    const p = req.body?.password ?? "";
    if (!safeCompare(p, password)) {
      return reply.code(401).send({
        success: false,
        error: { code: "unauthorized", message: "Неверный пароль" },
      });
    }
    const token = issueAdminSession();
    return { success: true, data: { token, expiresInSec: 60 * 60 * 24 * 7 } };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, "")?.trim();
    if (raw) {
      revokeAdminSession(raw);
    }
    return { success: true, data: { ok: true } };
  });

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? req.url;
    const publicApi =
      url === "/api/auth/login" ||
      url === "/api/health" ||
      url === "/api/wb/connect" ||
      url === "/api/settings/wb-token" ||
      url === "/api/settings/wb-token/test" ||
      url === "/api/settings/wb-token/verify-saved";
    if (!url.startsWith("/api/") || publicApi) {
      return;
    }
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, "")?.trim();
    if (!isAdminSessionValid(raw)) {
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
