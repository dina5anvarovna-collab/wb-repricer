import { logger } from "../lib/logger.js";
import { mapErrorToBlockReason, shouldRetryPublicParse } from "../lib/publicParseBlockReason.js";
import type { WalletParserInput, WalletParserResult } from "./wbWalletPriceParser.js";
import { getWbWalletPrice } from "./wbWalletPriceParser.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function withAttemptCount(base: WalletParserResult, attemptCount: number): WalletParserResult {
  return { ...base, attemptCount };
}

/**
 * До 2 попыток; backoff только для временных сбоев (см. shouldRetryPublicParse).
 */
export async function getWbWalletPriceWithPublicRetries(
  input: WalletParserInput,
): Promise<{ result: WalletParserResult; attemptCount: number }> {
  const maxAttempts = 2;
  let lastResult: WalletParserResult | null = null;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger.info(
      {
        tag: "public_parse_attempt",
        nmId: input.nmId,
        attempt,
        maxAttempts,
      },
      "public parse attempt",
    );
    try {
      const one = await getWbWalletPrice({ ...input, attemptIndex: attempt });
      lastResult = one;
      const br = one.blockReason ?? null;
      const ok =
        one.parseStatus !== "parse_failed" &&
        one.parseStatus !== "auth_required" &&
        one.parseStatus !== "blocked_or_captcha";

      logger.info(
        {
          tag: ok ? "public_parse_success" : "public_parse_failed",
          nmId: input.nmId,
          attempt,
          parseStatus: one.parseStatus,
          blockReason: br,
          priceParseSource: one.priceParseSource ?? null,
          confidence: one.sourceConfidence,
        },
        ok ? "public parse success" : "public parse finished without success",
      );

      if (ok || !shouldRetryPublicParse(br ?? undefined)) {
        return { result: withAttemptCount(one, attempt), attemptCount: attempt };
      }

      if (attempt < maxAttempts) {
        const backoff = attempt === 1 ? randomBetween(2000, 5000) : randomBetween(5000, 10_000);
        logger.warn(
          {
            tag: "public_parse_retry_scheduled",
            nmId: input.nmId,
            attempt,
            nextBackoffMs: backoff,
            reason: br,
          },
          "scheduling public parse retry",
        );
        await sleep(backoff);
      }
    } catch (e) {
      lastErr = e;
      const br = mapErrorToBlockReason(e);
      logger.error(
        {
          tag: "public_parse_failed",
          nmId: input.nmId,
          attempt,
          reason: br,
          err: e instanceof Error ? e.message : String(e),
        },
        "public parse threw",
      );
      const synthetic: WalletParserResult = {
        nmId: input.nmId ?? 0,
        url: "",
        region: input.region ?? null,
        priceRegular: null,
        discountedPrice: null,
        priceWallet: null,
        walletLabel: null,
        walletDiscountText: null,
        inStock: null,
        parsedAt: new Date().toISOString(),
        source: "dom",
        parseStatus: "parse_failed",
        sourceConfidence: 0,
        parseMethod: "exception",
        blockReason: br,
      };
      lastResult = synthetic;
      if (!shouldRetryPublicParse(br) || attempt >= maxAttempts) {
        return { result: withAttemptCount(synthetic, attempt), attemptCount: attempt };
      }
      const backoff = attempt === 1 ? randomBetween(2000, 5000) : randomBetween(5000, 10_000);
      logger.warn(
        {
          tag: "public_parse_retry_scheduled",
          nmId: input.nmId,
          attempt,
          nextBackoffMs: backoff,
          reason: br,
        },
        "scheduling retry after exception",
      );
      await sleep(backoff);
    }
  }

  return { result: withAttemptCount(lastResult!, maxAttempts), attemptCount: maxAttempts };
}
