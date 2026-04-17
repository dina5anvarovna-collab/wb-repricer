import pino from "pino";
import path from "node:path";
import { env } from "../config/env.js";
import { runtimePaths } from "./runtimePaths.js";

const redact = [
  "req.headers.authorization",
  "token",
  "wbToken",
  "cookie",
  "Cookie",
];

const prodFileDestination =
  env.NODE_ENV === "production"
    ? pino.destination({
        dest: path.join(runtimePaths.logDir, "app.log"),
        mkdir: true,
        sync: false,
      })
    : null;

export const logger = pino(
  {
  level: env.NODE_ENV === "development" ? "debug" : "info",
  redact: { paths: redact, censor: "[REDACTED]" },
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  },
  prodFileDestination
    ? pino.multistream([{ stream: process.stdout }, { stream: prodFileDestination }])
    : undefined,
);

export function safeTokenLog(last4: string): string {
  return `…${last4}`;
}
