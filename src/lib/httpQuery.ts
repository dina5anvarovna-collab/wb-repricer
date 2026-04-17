/**
 * Приводит req.query Fastify к плоскому объекту строк для zod.
 * Значения могут прийти как string | string[] | boolean | number.
 */
export function coerceQueryStringRecord(input: unknown): Record<string, string | undefined> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string | undefined> = {};
  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    if (raw === undefined || raw === null) {
      out[k] = undefined;
      continue;
    }
    if (Array.isArray(raw)) {
      const first = raw[0];
      out[k] = first === undefined || first === null ? undefined : String(first);
      continue;
    }
    if (typeof raw === "boolean") {
      out[k] = raw ? "true" : "false";
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[k] = String(raw);
      continue;
    }
    if (typeof raw === "string") {
      const t = raw.trim();
      out[k] = t === "" ? undefined : t;
      continue;
    }
    out[k] = String(raw);
  }
  return out;
}
