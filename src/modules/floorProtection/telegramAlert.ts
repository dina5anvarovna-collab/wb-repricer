/**
 * Telegram-уведомления для floor protection engine.
 * Простой fetch к Bot API без сторонних библиотек.
 *
 * Настройка: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID в .env
 * Если не заданы — логируем и пропускаем без ошибки.
 */

import { logger } from "../../lib/logger.js";

export type AlertKind =
  | "breach_detected"        // buyer price ниже floor
  | "price_raised"           // basePrice поднят
  | "price_raised_partial"   // поднят с шаговым капом (нарушение не закрыто полностью)
  | "verify_ok"              // post-verify: floor восстановлен
  | "verify_failed"          // post-verify: floor всё ещё нарушен
  | "sku_frozen"             // SKU заморожен после 3 неудачных попыток
  | "observation_failed";    // card.wb.ru не ответил для всех регионов

export type AlertPayload = {
  kind: AlertKind;
  nmId: number;
  floorPriceRub?: number;
  minBuyerPriceRub?: number;
  oldBase?: number;
  newBase?: number;
  worstCaseLabel?: string;
  gapRub?: number;
  retryNum?: number;
  dryRun?: boolean;
  extra?: string;
};

function formatMessage(p: AlertPayload): string {
  const prefix = p.dryRun ? "[DRY RUN] " : "";
  const nm = `#${p.nmId}`;
  const floor = p.floorPriceRub != null ? `floor=${p.floorPriceRub}₽` : "";
  const buyer = p.minBuyerPriceRub != null ? `buyer=${p.minBuyerPriceRub}₽` : "";
  const region = p.worstCaseLabel ? `(${p.worstCaseLabel})` : "";
  const gap = p.gapRub != null ? `gap=${p.gapRub}₽` : "";

  switch (p.kind) {
    case "breach_detected":
      return `${prefix}🔴 НАРУШЕНИЕ FLOOR ${nm}\n${buyer} < ${floor} ${region}\n${gap}`;

    case "price_raised":
      return `${prefix}⬆️ Цена поднята ${nm}\n${p.oldBase}₽ → ${p.newBase}₽\n${buyer} < ${floor} ${region}`;

    case "price_raised_partial":
      return `${prefix}⚠️ Частичное повышение ${nm}\n${p.oldBase}₽ → ${p.newBase}₽ (step cap)\n${buyer} < ${floor} — нарушение закроется в следующем цикле`;

    case "verify_ok":
      return `${prefix}✅ Floor восстановлен ${nm}\n${buyer} ≥ ${floor} ${region}`;

    case "verify_failed":
      return `${prefix}🔴 POST-VERIFY FAILED ${nm} (попытка ${p.retryNum ?? "?"})\n${buyer} < ${floor} ${region}\n${gap}`;

    case "sku_frozen":
      return `${prefix}🚫 SKU ЗАМОРОЖЕН ${nm}\nПревышено число попыток восстановления floor.\nНужна ручная проверка. ${floor}`;

    case "observation_failed":
      return `${prefix}⚠️ card.wb.ru недоступен ${nm}\nВсе регионы вернули ошибку. Пропускаем цикл.\n${p.extra ?? ""}`;

    default:
      return `${prefix}[floor-protect] ${nm} ${p.kind}`;
  }
}

export async function sendTelegramAlert(
  payload: AlertPayload,
  opts: { botToken?: string; chatId?: string } = {},
): Promise<void> {
  const token = opts.botToken?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const chatId = opts.chatId?.trim() || process.env.TELEGRAM_CHAT_ID?.trim() || "";

  if (!token || !chatId) {
    logger.debug({ tag: "tg_alert_skipped", kind: payload.kind, nmId: payload.nmId },
      "Telegram не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы)");
    return;
  }

  const text = formatMessage(payload);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ tag: "tg_alert_fail", status: res.status, body: body.slice(0, 200) },
        "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.warn({ tag: "tg_alert_error", err: String(err) }, "Telegram fetch error");
  }
}
