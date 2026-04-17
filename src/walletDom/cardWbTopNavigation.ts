import type { Page } from "playwright";
import { logger } from "../lib/logger.js";
import { parseShowcaseRubFromCardDetailJsonOrNested } from "./buyerShowcaseCardRequest.js";

const TAG = "card-wb-topnav";

/**
 * Открыть JSON карточки как обычную навигацию вкладки (document request).
 * WB часто отдаёт 403 на fetch/APIRequestContext, но 200 на top-level navigation с тем же профилем.
 */
export async function tryShowcaseRubViaCardWbTopLevelNavigation(
  page: Page,
  nmId: number,
  regionDest: string | null | undefined,
  restoreUrl: string,
): Promise<number | null> {
  const dest = regionDest?.trim() || "-1257786";
  const paths = ["/cards/v4/detail", "/cards/v2/detail", "/cards/v1/detail"] as const;

  for (const path of paths) {
    const cardUrl = `https://card.wb.ru${path}?appType=1&curr=rub&dest=${encodeURIComponent(dest)}&nm=${nmId}`;
    try {
      const resp = await page.goto(cardUrl, {
        waitUntil: "load",
        timeout: 32_000,
      });
      const status = resp?.status() ?? 0;
      if (!resp || status !== 200) {
        logger.info({ tag: TAG, nmId, path, status }, "card.wb.ru top navigation: не 200");
        continue;
      }
      const text = await resp.text().catch(() => "");
      const tr = text.trim();
      if (!tr.startsWith("{") && !tr.startsWith("[")) {
        continue;
      }
      let data: unknown;
      try {
        data = JSON.parse(tr) as unknown;
      } catch {
        continue;
      }
      const rub = parseShowcaseRubFromCardDetailJsonOrNested(data, nmId);
      if (rub != null) {
        logger.info({ tag: TAG, nmId, path, rub }, "card.wb.ru: цена через верхнюю навигацию вкладки");
        try {
          await page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 40_000 });
        } catch {
          /* следующий товар сделает свой goto */
        }
        return rub;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.info({ tag: TAG, nmId, path, err: msg }, "card.wb.ru top navigation: ошибка");
    }
  }

  try {
    if (page.url().includes("card.wb.ru")) {
      await page.goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 40_000 });
    }
  } catch {
    /* */
  }
  return null;
}
