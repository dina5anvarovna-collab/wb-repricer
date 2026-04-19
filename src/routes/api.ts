import fs from "node:fs";
import path from "node:path";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import {
  acquireSchedulerLock,
  releaseSchedulerLock,
  schedulerLockOwnerLabel,
} from "../lib/schedulerLock.js";
import { getAppSetting, setAppSetting } from "../lib/appSettings.js";
import { enrichProductsForTable } from "../lib/productTableEnrichment.js";
import {
  getActiveCabinetToken,
  resolveBuyerProfileDir,
  syncCatalogFromSeller,
  upsertMinPriceRule,
  upsertSellerToken,
} from "../modules/catalogSync/syncCatalog.js";
import { coerceQueryStringRecord } from "../lib/httpQuery.js";
import { loadWbRegions } from "../lib/wbRegions.js";
import {
  MONITOR_INTERVAL_MAX_HOURS,
  MONITOR_INTERVAL_MIN_HOURS,
  parseMonitorIntervalHoursInput,
  setMonitorLastTickAt,
} from "../lib/monitorPrefs.js";
import {
  resolveWalletRegionOpts,
  runEnforcementJob,
} from "../modules/priceEnforcement/runEnforcementJob.js";
import { runPriceMonitorJob } from "../modules/priceMonitor/runMonitor.js";
import {
  fetchQuarantineGoodsPage,
  normalizeSellerApiToken,
  validateSellerToken,
} from "../modules/wbSellerApi/client.js";
import {
  buildExtendedDashboardPayload,
  buildSellerStatusPayload,
  getMonitorIntervalHours,
  getPrimaryWalletRegion,
  getSelectedRegionDests,
  setMonitorIntervalHours,
  setSelectedRegionDests,
} from "../services/dashboardService.js";
import { runtimePaths } from "../lib/runtimePaths.js";
import {
  bulkSetControlEnabled,
  bulkUpdateMinPrice,
  listDistinctBrands,
  listProductsForCatalog,
} from "../repositories/catalogRepository.js";
import { registerUnifiedWbRoutes } from "./unifiedWbRoutes.js";
import { normalizeWbProductFromDb } from "../modules/wbData/normalizeProduct.js";
import {
  headedBrowserLoginBlockedMessage,
  headedBrowserLoginEnvironmentOk,
  importBuyerBrowserProfileArchive,
  importBuyerStorageStateFromJson,
  spawnBuyerLoginWindowIfConfigured,
  verifyBuyerSessionAfterLogin,
} from "../modules/buyerSession/buyerSessionManager.js";
import { resolveWalletDomBrowserKind } from "../modules/wbBuyerDom/runWalletCli.js";
import { getWbWalletPrice } from "../walletDom/wbWalletPriceParser.js";
import { getWbWalletPriceWithPublicRetries } from "../walletDom/publicParseRetry.js";
import { getLastPublicParseProbe, recordPublicParseProbe } from "../lib/publicParseProbeState.js";
import {
  getLastBrowserParseProbe,
  recordBrowserParseProbe,
} from "../lib/browserParseProbeState.js";
import { checkBuyerSession } from "../lib/buyerSessionCheck.js";
import { normalizeParseProbePriceFields } from "../lib/parseProbeApiNormalization.js";
import {
  buildBuyerSideFromWalletParserLike,
  buildSellerSideFromWbProduct,
  buildUnifiedObservation,
  EMPTY_SELLER_SIDE,
} from "../lib/unifiedPriceModel.js";
import { resolveWbBrowserHeadless } from "../lib/wbBrowserEnv.js";
import { isBuyerAuthDisabled, isPublicOnlyWalletParse } from "../lib/repricerMode.js";
import {
  createEphemeralWalletProfileDir,
  removeEphemeralWalletProfileDir,
} from "../lib/ephemeralWalletProfile.js";
import type { WalletParserResult } from "../walletDom/wbWalletPriceParser.js";

async function unifiedPriceObservationForProbe(nmId: number, result: WalletParserResult) {
  const p = await prisma.wbProduct.findFirst({
    where: { nmId },
    select: { sellerPrice: true, sellerDiscount: true, discountedPriceRub: true },
  });
  const buyer = buildBuyerSideFromWalletParserLike(result);
  if (!p) return buildUnifiedObservation(EMPTY_SELLER_SIDE, buyer);
  return buildUnifiedObservation(buildSellerSideFromWbProduct(p), buyer);
}

function parseQueryLimit(raw: string | undefined, fallback: number, cap: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), cap);
}

function parseQueryOffset(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function buyerAuthDisabledBody() {
  return {
    ok: false as const,
    error: "Buyer authorization paths are disabled (set REPRICER_DISABLE_BUYER_AUTH=false to enable legacy flow).",
    code: "buyer_auth_disabled" as const,
  };
}

const qTrimmedOptional = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}, z.string().optional());

const catalogListQuerySchema = z.object({
  search: qTrimmedOptional,
  evaluationStatus: qTrimmedOptional,
  brand: qTrimmedOptional,
  /** true = точное имя бренда (для списка из GET /api/catalog/brands) */
  brandExact: z.enum(["true", "false"]).optional(),
  /** with = stock &gt; 0, without = null или 0 */
  stock: z.enum(["with", "without"]).optional(),
  controlEnabled: z.enum(["true", "false"]).optional(),
  belowMin: z.enum(["true", "false"]).optional(),
  parseFailed: z.enum(["true", "false"]).optional(),
  /** true = участвуют в buyer-парсинге, false = отключены от мониторинга */
  buyerParse: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().min(1).max(500).optional(),
  offset: z.coerce.number().min(0).optional(),
  sortBy: z.enum(["nmId", "title", "updatedAt", "lastMonitorAt"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: 80 * 1024 * 1024 },
  });
  registerUnifiedWbRoutes(app);

  app.post<{ Body: { token?: string; name?: string } }>("/api/wb/connect", async (req, reply) => {
    if (req.body == null || typeof req.body !== "object") {
      return reply.code(400).send({
        error:
          "Тело запроса не пришло (ожидается JSON). Откройте админку по http://127.0.0.1:PORT/admin.html, а не как файл с диска, либо укажите «Базовый URL API» на вкладке «Подключение».",
      });
    }
    const raw = req.body?.token;
    if (typeof raw !== "string" || !normalizeSellerApiToken(raw)) {
      return reply.code(400).send({ error: "Укажите непустой токен в JSON: {\"token\":\"…\"}" });
    }
    try {
      const r = await upsertSellerToken(raw, req.body?.name ?? "default");
      return { ok: true, cabinetId: r.id, tokenLast4: r.tokenLast4 };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(e, "wb connect failed");
      return reply.code(500).send({ error: msg });
    }
  });

  app.post("/api/wb/sync", async (req, reply) => {
    const auth = await getActiveCabinetToken();
    if (!auth) {
      return reply
        .code(400)
        .send({ error: "Токен не настроен или не расшифровывается (сохраните токен заново, проверьте REPRICER_MASTER_SECRET)" });
    }
    const syncResult = await syncCatalogFromSeller(auth.cabinetId, auth.token);
    return {
      ok: true,
      ...syncResult,
      hint:
        syncResult.upserted === 0
          ? "WB вернул 0 товаров. Проверьте токен категории «Цены и скидки», наличие товаров в кабинете и повторите через минуту (лимиты API)."
          : undefined,
    };
  });

  app.get("/api/wb/status", async () => buildSellerStatusPayload());

  app.post<{ Body: { token?: string; name?: string } }>("/api/settings/wb-token", async (req, reply) => {
    const raw = req.body?.token;
    if (typeof raw !== "string" || !normalizeSellerApiToken(raw)) {
      return reply.code(400).send({ error: "Укажите непустой токен" });
    }
    const r = await upsertSellerToken(raw, req.body?.name ?? "default");
    return { ok: true, cabinetId: r.id, tokenLast4: r.tokenLast4 };
  });

  app.post<{ Body: { token?: string } }>("/api/settings/wb-token/test", async (req, reply) => {
    const raw = req.body?.token;
    if (typeof raw !== "string" || !normalizeSellerApiToken(raw)) {
      return reply.code(400).send({ error: "Вставьте токен в тело запроса: {\"token\":\"…\"}" });
    }
    try {
      await validateSellerToken(raw);
      return { ok: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: msg });
    }
  });

  app.post("/api/settings/wb-token/verify-saved", async (req, reply) => {
    const auth = await getActiveCabinetToken();
    if (!auth) {
      return reply.code(400).send({
        error:
          "Нет сохранённого токена или ошибка расшифровки (проверьте REPRICER_MASTER_SECRET, сохраните ключ снова)",
      });
    }
    try {
      await validateSellerToken(auth.token);
      return { ok: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ ok: false, error: msg });
    }
  });

  app.post("/api/settings/buyer-session/login/start", async (_req, reply) => {
    if (isBuyerAuthDisabled()) {
      return reply.code(410).send(buyerAuthDisabledBody());
    }
    const headedOk = headedBrowserLoginEnvironmentOk();
    const profileDir = resolveBuyerProfileDir();
    const session = await prisma.buyerSession.create({
      data: {
        profileDir,
        isAuthorized: false,
        status: "pending_login",
        lastProbeOk: false,
        notes: JSON.stringify({ phase: "awaiting_cli_login" }),
      },
    });
    const projectRoot = path.isAbsolute(env.REPRICER_WALLET_PROJECT_ROOT)
      ? env.REPRICER_WALLET_PROJECT_ROOT
      : runtimePaths.projectRoot;
    const cliRel = env.REPRICER_WALLET_CLI_PATH;
    const cliPath = path.isAbsolute(cliRel) ? cliRel : path.resolve(runtimePaths.projectRoot, cliRel);
    const cliExists = fs.existsSync(cliPath);
    const browser =
      process.env.REPRICER_DOM_BROWSER?.trim().toLowerCase() === "chrome" ? "chrome" : "chromium";
    const nodeBin = process.execPath;
    const cmd = `cd "${projectRoot}" && "${nodeBin}" "${cliPath}" --login=true --headless=false --userDataDir="${profileDir}" --browser=${browser}`;
    const hints: string[] = [];
    if (!headedOk) {
      hints.push(headedBrowserLoginBlockedMessage());
    }
    if (!cliExists) {
      hints.push(
        `Файл CLI не найден (${cliPath}). В каталоге проекта выполните: npm run build`,
      );
    }
    if (browser === "chromium") {
      hints.push("Один раз установите браузер для Playwright: npx playwright install chromium");
    } else {
      hints.push(
        "Выбран Chrome (REPRICER_DOM_BROWSER=chrome). Если не запускается, уберите переменную и используйте chromium.",
      );
    }
    hints.push("Команда должна выполняться на той же машине, где запущен сервер repricer.");
    const spawnRes =
      cliExists && headedOk ? spawnBuyerLoginWindowIfConfigured(cmd) : { attempted: false, started: false };
    if (spawnRes.attempted && spawnRes.started) {
      hints.unshift(
        "Окно входа WB запущено автоматически в фоне. Если его не видно — проверьте Dock / другой рабочий стол или выполните команду вручную в терминале.",
      );
    } else if (spawnRes.attempted && !spawnRes.started && spawnRes.error) {
      hints.unshift(`Автозапуск браузера не вышел (${spawnRes.error}) — выполните команду вручную в терминале.`);
    }
    return {
      sessionId: session.id,
      profileDir,
      cliPath,
      cliExists,
      browser,
      headedLoginAvailable: headedOk,
      autoLoginWindowSpawned: spawnRes.started,
      autoLoginWindowAttempted: spawnRes.attempted,
      instruction:
        spawnRes.started
          ? "Должно открыться окно браузера для входа в Wildberries. Войдите как покупатель, затем в панели нажмите «Подтвердить вход». Если окна нет — откройте терминал на этой машине и выполните команду ниже."
          : "На машине, где запущен сервер repricer, откройте терминал и выполните команду ниже — откроется браузер. Войдите в Wildberries как покупатель, затем нажмите «Подтвердить вход».",
      cliCommand: cmd,
      hints,
    };
  });

  app.post<{ Body: { sessionId?: string } }>(
    "/api/settings/buyer-session/login/finish",
    async (req, reply) => {
      if (isBuyerAuthDisabled()) {
        return reply.code(410).send(buyerAuthDisabledBody());
      }
      const id = req.body?.sessionId?.trim();
      if (!id) return reply.code(400).send({ error: "sessionId required" });
      try {
        const result = await verifyBuyerSessionAfterLogin(id);
        if (!result.ok) {
          return reply.code(400).send({
            ok: false,
            error: result.message,
            probe: result.probe,
          });
        }
        const s = await prisma.buyerSession.findUnique({ where: { id } });
        return { ok: true, session: s, probe: result.probe };
      } catch (e: unknown) {
        if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(404).send({ error: "session not found" });
        }
        throw e;
      }
    },
  );

  /**
   * Импорт Playwright storageState JSON с рабочего ПК (после wallet:login / экспорта) — для VPS без GUI.
   * Тело: полный JSON как в файле REPRICER_WB_STORAGE_STATE_PATH.
   */
  app.post("/api/settings/buyer-session/import-storage-state", async (req, reply) => {
    if (isBuyerAuthDisabled()) {
      return reply.code(410).send(buyerAuthDisabledBody());
    }
    const result = await importBuyerStorageStateFromJson(req.body ?? null);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.message });
    }
    return { ok: true, message: result.message };
  });

  /** ZIP архива каталога Chromium `.wb-browser-profile` (локальный логин + загрузка на VPS). */
  app.post("/api/settings/buyer-session/import-profile-archive", async (req, reply) => {
    if (isBuyerAuthDisabled()) {
      return reply.code(410).send(buyerAuthDisabledBody());
    }
    const f = await req.file();
    if (!f) {
      return reply.code(400).send({ ok: false, error: "Ожидается multipart поле file с zip-архивом профиля" });
    }
    const chunks: Buffer[] = [];
    for await (const ch of f.file) {
      chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
    }
    const buf = Buffer.concat(chunks);
    const result = await importBuyerBrowserProfileArchive(buf);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.message });
    }
    return { ok: true, message: result.message };
  });

  /** Пробный парсинг одной карточки тем же пайплайном, что мониторинг (public + card по .env). */
  app.post<{ Body: { nmId?: number } }>("/api/settings/parse-probe-public", async (req, reply) => {
    const raw = req.body?.nmId;
    const nmId = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(nmId) || nmId < 1) {
      return reply.code(400).send({ error: "Укажите nmId в JSON: { \"nmId\": 123 }" });
    }
    const spp =
      !isBuyerAuthDisabled() &&
      !(
        env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase() === "0" ||
        env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase() === "false" ||
        env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase() === "no"
      );
    let probeProfileDir = resolveBuyerProfileDir();
    let ephemeralProbeDir: string | null = null;
    if (isBuyerAuthDisabled()) {
      ephemeralProbeDir = createEphemeralWalletProfileDir();
      probeProfileDir = ephemeralProbeDir;
      logger.info({ nmId, tag: "parse-probe-public" }, "public parse started — ephemeral profile");
    }
    try {
      const commonOpts = {
        nmId,
        userDataDir: probeProfileDir,
        browser: resolveWalletDomBrowserKind(),
        fetchShowcaseWithCookies: spp,
        applyPublicBrowserEnv: isBuyerAuthDisabled(),
        ...(isBuyerAuthDisabled()
          ? { headless: undefined }
          : { headless: true }),
      };

      const { result, attemptCount } =
        isBuyerAuthDisabled()
          ? await getWbWalletPriceWithPublicRetries(commonOpts)
          : { result: await getWbWalletPrice(commonOpts), attemptCount: 1 };

      const okParse =
        result.parseStatus !== "parse_failed" &&
        result.parseStatus !== "auth_required" &&
        result.parseStatus !== "blocked_or_captcha";
      if (result.priceParseSource === "popup_dom") {
        logger.info({ nmId, tag: "parse-probe-public" }, "popup parse success");
      } else if (result.priceParseSource === "public_dom") {
        logger.info({ nmId, tag: "parse-probe-public" }, "public dom parsed");
      }

      recordPublicParseProbe({
        at: new Date().toISOString(),
        nmId,
        ok: okParse,
        parseStatus: result.parseStatus,
        blockReason: result.blockReason ?? null,
        priceParseSource: result.priceParseSource ?? null,
        confidence: result.sourceConfidence ?? null,
        browserUrlAfterParse: result.browserUrlAfterParse ?? null,
        pageTitle: result.pageTitle ?? null,
        attemptCount,
        debugArtifactPaths: result.debugArtifactPaths ?? [],
      });

      const unifiedPrice = await unifiedPriceObservationForProbe(nmId, result);

      return {
        ok: okParse,
        parseStatus: result.parseStatus,
        blockReason: result.blockReason ?? null,
        priceParseSource: result.priceParseSource ?? null,
        nmId: result.nmId,
        priceRegular: result.priceRegular ?? null,
        showcaseRub: result.showcaseRub ?? result.showcaseRubEffective ?? null,
        walletRub: result.walletRub ?? null,
        nonWalletRub: result.nonWalletRub ?? result.priceWithSppWithoutWalletRub ?? null,
        walletConfirmed: result.walletConfirmed ?? false,
        walletEvidence: result.walletEvidence ?? null,
        showcaseRubEffective: result.showcaseRubEffective ?? null,
        walletHint: result.priceWallet,
        browserUrlAfterParse: result.browserUrlAfterParse ?? null,
        pageTitle: result.pageTitle ?? null,
        confidence: result.sourceConfidence,
        debugArtifactPaths: result.debugArtifactPaths ?? [],
        attemptCount,
        unifiedPrice,
        raw: result,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ nmId, tag: "parse-probe-public", err: msg }, "parse failed");
      return reply.code(500).send({ ok: false, error: msg });
    } finally {
      if (ephemeralProbeDir) {
        removeEphemeralWalletProfileDir(ephemeralProbeDir);
      }
    }
  });

  /** Проба карточки persistent buyer-профилем (основной контур wallet DOM). */
  app.post<{ Body: { nmId?: number } }>("/api/settings/parse-probe-browser", async (req, reply) => {
    if (isBuyerAuthDisabled()) {
      return reply.code(410).send(buyerAuthDisabledBody());
    }
    const raw = req.body?.nmId;
    const nmId = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(nmId) || nmId < 1) {
      return reply.code(400).send({ error: "Укажите nmId в JSON: { \"nmId\": 123 }" });
    }
    const probeProfileDir = resolveBuyerProfileDir();
    const spp =
      !(
        env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase() === "0" ||
        env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase() === "false" ||
        env.REPRICER_MONITOR_SPP_VIA_COOKIES.trim().toLowerCase() === "no"
      );
    try {
      const result = await getWbWalletPrice({
        nmId,
        userDataDir: probeProfileDir,
        headless: resolveWbBrowserHeadless(),
        browser: resolveWalletDomBrowserKind(),
        fetchShowcaseWithCookies: spp,
        applyPublicBrowserEnv: false,
        region: env.REPRICER_WALLET_DEST.trim() || undefined,
      });
      const okParse =
        result.parseStatus !== "parse_failed" &&
        result.parseStatus !== "auth_required" &&
        result.parseStatus !== "blocked_or_captcha";
      recordBrowserParseProbe({
        at: new Date().toISOString(),
        nmId,
        ok: okParse,
        parseStatus: result.parseStatus,
        blockReason: result.blockReason ?? null,
        priceParseSource: result.priceParseSource ?? null,
        confidence: result.sourceConfidence ?? null,
        browserUrlAfterParse: result.browserUrlAfterParse ?? null,
        pageTitle: result.pageTitle ?? null,
        monitorParseContour: "browser_primary",
        debugArtifactPaths: result.debugArtifactPaths ?? [],
      });
      logger.info({ nmId, tag: "parse-probe-browser", ok: okParse }, "browser wallet probe done");
      const norm = normalizeParseProbePriceFields(result);
      const unifiedPrice = await unifiedPriceObservationForProbe(nmId, result);
      return {
        ok: okParse,
        parseStatus: result.parseStatus,
        blockReason: result.blockReason ?? null,
        priceParseSource: result.priceParseSource ?? null,
        nmId: result.nmId,
        ...norm,
        showcaseRubEffective: result.showcaseRubEffective ?? null,
        walletHint: result.priceWallet,
        browserUrlAfterParse: result.browserUrlAfterParse ?? null,
        pageTitle: result.pageTitle ?? null,
        confidence: result.sourceConfidence,
        debugArtifactPaths: result.debugArtifactPaths ?? [],
        unifiedPrice,
        raw: result,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ nmId, tag: "parse-probe-browser", err: msg }, "browser probe failed");
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  app.get("/api/browser-parse/status", async () => ({
    lastBrowserProbe: getLastBrowserParseProbe(),
  }));

  /** Быстрая проверка buyer-профиля (может занять десятки секунд из-за карточки-probe). */
  app.get("/api/buyer-session/check", async () => {
    if (isBuyerAuthDisabled()) {
      return { disabled: true, reason: "REPRICER_DISABLE_BUYER_AUTH" };
    }
    return checkBuyerSession(resolveBuyerProfileDir());
  });

  /** Сводка публичного парсинга и safe mode (без buyer-session). */
  app.get("/api/public-parse/status", async () => {
    const lastMonitor = await prisma.syncJob.findFirst({
      where: { type: "monitor" },
      orderBy: { startedAt: "desc" },
    });
    let parseStats: Record<string, unknown> | null = null;
    let processedProducts: unknown = null;
    if (lastMonitor?.meta) {
      try {
        const m = JSON.parse(lastMonitor.meta) as {
          parseStats?: Record<string, unknown>;
          processedProducts?: unknown;
        };
        parseStats = (m.parseStats as Record<string, unknown>) ?? null;
        processedProducts = m.processedProducts ?? null;
      } catch {
        parseStats = null;
      }
    }
    const stats = parseStats as {
      publicDom?: number;
      popupDom?: number;
      unknown?: number;
      authWall?: number;
      captcha?: number;
      safeModeLastGood?: number;
    } | null;
    const safeHoldCount = await prisma.wbProduct.count({ where: { safeModeHold: true } });
    const lastGoodSample = await prisma.wbProduct.findFirst({
      where: { walletRubLastGood: { not: null } },
      orderBy: { walletRubLastGoodAt: "desc" },
      select: {
        nmId: true,
        walletRubLastGood: true,
        walletRubLastGoodAt: true,
        sourceLastGood: true,
        parseStatusLastGood: true,
        safeModeHold: true,
      },
    });
    const stepsTotal =
      stats &&
      typeof stats.publicDom === "number" &&
      typeof stats.popupDom === "number" &&
      typeof stats.unknown === "number"
        ? stats.publicDom + stats.popupDom + stats.unknown
        : null;

    return {
      buyerAuthDisabled: isBuyerAuthDisabled(),
      publicOnly: isPublicOnlyWalletParse(),
      lastPublicProbe: getLastPublicParseProbe(),
      env: {
        REPRICER_DISABLE_BUYER_AUTH: env.REPRICER_DISABLE_BUYER_AUTH,
        REPRICER_WALLET_PARSE_MODE: env.REPRICER_WALLET_PARSE_MODE,
        REPRICER_WALLET_DETAILS_MODE: env.REPRICER_WALLET_DETAILS_MODE,
        REPRICER_MONITOR_SPP_VIA_COOKIES: env.REPRICER_MONITOR_SPP_VIA_COOKIES,
      },
      lastMonitorJob: lastMonitor
        ? {
            id: lastMonitor.id,
            status: lastMonitor.status,
            startedAt: lastMonitor.startedAt.toISOString(),
            finishedAt: lastMonitor.finishedAt?.toISOString() ?? null,
            processedProducts,
          }
        : null,
      parseStats,
      interpretation: stats
        ? {
            publicDomOk:
              stepsTotal != null && stepsTotal > 0 ? (stats.publicDom ?? 0) > 0 : null,
            popupParseOk:
              stepsTotal != null && stepsTotal > 0 ? (stats.popupDom ?? 0) > 0 : null,
            walletMarkersLikely:
              stepsTotal != null && stepsTotal > 0
                ? (stats.publicDom ?? 0) + (stats.popupDom ?? 0) > 0
                : null,
            parseSourceMix: stats,
            confidenceNote:
              "confidence по шагам — в detailJson снимков; здесь только счётчики доменов парсинга.",
          }
        : null,
      safeMode: {
        activeProducts: safeHoldCount,
        lastKnownGood: lastGoodSample,
      },
    };
  });

  app.get("/api/settings/status", async () => buildSellerStatusPayload());

  app.post("/api/catalog/sync", async (req, reply) => {
    const auth = await getActiveCabinetToken();
    if (!auth) return reply.code(400).send({ error: "seller token not configured" });
    const syncResult = await syncCatalogFromSeller(auth.cabinetId, auth.token);
    return {
      ok: true,
      ...syncResult,
      hint:
        syncResult.upserted === 0
          ? "WB вернул 0 товаров. Проверьте токен категории «Цены и скидки» и кабинет."
          : undefined,
    };
  });

  app.get("/api/catalog/products", async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = parseQueryLimit(q.limit, 50, 500);
    const offset = parseQueryOffset(q.offset);
    const [rows, total, selectedDests] = await Promise.all([
      prisma.wbProduct.findMany({
        take: limit,
        skip: offset,
        orderBy: { nmId: "asc" },
        include: { minPriceRule: true },
      }),
      prisma.wbProduct.count(),
      getSelectedRegionDests(),
    ]);
    const items = await enrichProductsForTable(rows, selectedDests);
    const safeModeRecommendationOnly = ["1", "true", "yes", "on"].includes(
      env.REPRICER_ENFORCE_CRON_DRY_RUN.trim().toLowerCase(),
    );
    return { total, items, selectedRegionDests: selectedDests, safeModeRecommendationOnly };
  });

  app.get("/api/catalog/products-v2", async (req, reply) => {
    const parsed = catalogListQuerySchema.safeParse(coerceQueryStringRecord(req.query));
    if (!parsed.success) {
      return reply.code(400).send({ error: "Некорректные query-параметры", zod: parsed.error.flatten() });
    }
    const q = parsed.data;
    const { rows, total } = await listProductsForCatalog({
      search: q.search,
      evaluationStatus: q.evaluationStatus,
      brand: q.brand,
      brandExact: q.brandExact === "true",
      stock: q.stock === "with" ? "with" : q.stock === "without" ? "without" : undefined,
      controlEnabled:
        q.controlEnabled === "true" ? true : q.controlEnabled === "false" ? false : undefined,
      belowMin: q.belowMin === "true",
      parseFailed: q.parseFailed === "true",
      buyerParseEnabled:
        q.buyerParse === "true" ? true : q.buyerParse === "false" ? false : undefined,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
      sortBy: q.sortBy ?? "nmId",
      sortDir: q.sortDir ?? "asc",
    });
    const selectedDests = await getSelectedRegionDests();
    const items = await enrichProductsForTable(rows, selectedDests);

    let catalogHint: string | undefined;
    if (selectedDests.length === 0) {
      catalogHint =
        "Регионы мониторинга не выбраны (Настройки → Регионы). Без этого в таблице не будет цен витрины/кошелька.";
    } else if (rows.length > 0) {
      const noBuyerPrices = items.every(
        (it) =>
          (it.showcaseFinalRub == null || it.showcaseFinalRub <= 0) &&
          (it.lastWalletObservedRub == null || it.lastWalletObservedRub <= 0) &&
          (it.lastRegularObservedRub == null || it.lastRegularObservedRub <= 0),
      );
      if (noBuyerPrices) {
        catalogHint =
          "Нет снимков цен покупателя (кошелёк / витрина): запустите мониторинг после входа WB Покупатель. % СПП считается от цены «со скидкой продавца» — выполните синхронизацию каталога из кабинета.";
      }
    }

    return {
      total,
      items,
      selectedRegionDests: selectedDests,
      catalogHint,
      safeModeRecommendationOnly: ["1", "true", "yes", "on"].includes(
        env.REPRICER_ENFORCE_CRON_DRY_RUN.trim().toLowerCase(),
      ),
    };
  });

  app.get("/api/catalog/brands", async () => {
    const items = await listDistinctBrands(400);
    return { items };
  });

  app.post<{ Body: { productIds?: string[]; controlEnabled?: boolean } }>(
    "/api/catalog/bulk-control",
    async (req, reply) => {
      const schema = z.object({
        productIds: z.array(z.string().min(1)).min(1),
        controlEnabled: z.boolean(),
      });
      const body = schema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "productIds[] и controlEnabled обязательны" });
      }
      const n = await bulkSetControlEnabled(body.data.productIds, body.data.controlEnabled);
      return { ok: true, updatedRules: n };
    },
  );

  app.post<{ Body: { productIds?: string[]; buyerParseEnabled?: boolean } }>(
    "/api/catalog/bulk-buyer-parse",
    async (req, reply) => {
      const schema = z.object({
        productIds: z.array(z.string().min(1)).min(1),
        buyerParseEnabled: z.boolean(),
      });
      const body = schema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "productIds[] и buyerParseEnabled (boolean) обязательны" });
      }
      const r = await prisma.wbProduct.updateMany({
        where: { id: { in: body.data.productIds } },
        data: { buyerParseEnabled: body.data.buyerParseEnabled },
      });
      return { ok: true, updatedProducts: r.count };
    },
  );

  app.post<{ Body: { items?: Array<{ nmId: number; minAllowedFinalPrice: number }> } }>(
    "/api/catalog/bulk-min-prices",
    async (req, reply) => {
      const schema = z.object({
        items: z
          .array(
            z.object({
              nmId: z.number().int().positive(),
              minAllowedFinalPrice: z.number().positive(),
            }),
          )
          .min(1)
          .max(2000),
      });
      const body = schema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "items[{ nmId, minAllowedFinalPrice }] обязателен" });
      }
      const batch = await prisma.massUpdateBatch.create({
        data: { kind: "bulk_min", itemCount: body.data.items.length, metaJson: "{}" },
      });
      const updates: Array<{ productId: string; nmId: number; minAllowedFinalPrice: number }> = [];
      for (const it of body.data.items) {
        const p = await prisma.wbProduct.findFirst({ where: { nmId: it.nmId } });
        if (p) {
          updates.push({
            productId: p.id,
            nmId: p.nmId,
            minAllowedFinalPrice: it.minAllowedFinalPrice,
          });
        }
      }
      const n = await bulkUpdateMinPrice(updates, batch.id);
      return { ok: true, updated: n, batchId: batch.id, requested: body.data.items.length };
    },
  );

  app.post<{ Body: { nmId?: number; targetPrice?: number; source?: string } }>(
    "/api/fixed-prices/set",
    async (req, reply) => {
      const nmId = req.body?.nmId;
      const price = req.body?.targetPrice;
      if (!Number.isFinite(nmId) || !Number.isFinite(price)) {
        return reply.code(400).send({ error: "nmId and targetPrice required" });
      }
      const p = await prisma.wbProduct.findFirst({ where: { nmId: nmId! } });
      if (!p) return reply.code(404).send({ error: "product not found; run catalog sync" });
      const row = await prisma.fixedTargetPrice.create({
        data: {
          productId: p.id,
          nmId: nmId!,
          targetPrice: price!,
          source: req.body?.source ?? "manual",
        },
      });
      await upsertMinPriceRule(p.id, price!, { comment: req.body?.source ?? "manual" });
      return { ok: true, id: row.id };
    },
  );

  app.post<{ Body: { rows?: Array<{ nmId: number; targetPrice: number }> } }>(
    "/api/fixed-prices/import",
    async (req, reply) => {
      const rows = req.body?.rows;
      if (!Array.isArray(rows)) return reply.code(400).send({ error: "rows[] required" });
      let n = 0;
      for (const r of rows) {
        const p = await prisma.wbProduct.findFirst({ where: { nmId: r.nmId } });
        if (!p) continue;
        await prisma.fixedTargetPrice.create({
          data: {
            productId: p.id,
            nmId: r.nmId,
            targetPrice: r.targetPrice,
            source: "import",
          },
        });
        await upsertMinPriceRule(p.id, r.targetPrice, { comment: "import" });
        n += 1;
      }
      return { ok: true, imported: n };
    },
  );

  app.get("/api/fixed-prices", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseQueryLimit(q.limit, 200, 1000);
    const rows = await prisma.fixedTargetPrice.findMany({
      take: limit,
      orderBy: { updatedAt: "desc" },
      include: { product: { select: { nmId: true, title: true } } },
    });
    return { items: rows };
  });

  app.post("/api/monitor/run", async (req, reply) => {
    const body = req.body as { maxProducts?: number } | undefined;
    const rawMax = body?.maxProducts;
    const maxProducts =
      typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
        ? Math.min(Math.floor(rawMax), 5000)
        : 30;
    const ok = await acquireSchedulerLock("monitor");
    if (!ok) {
      logger.warn({ tag: "monitor_skipped_lock_active" }, "api /api/monitor/run — lock held");
      return reply.code(409).send({
        error:
          "Мониторинг уже выполняется (lock monitor). Дождитесь завершения или истечения TTL (REPRICER_SCHEDULER_LOCK_TTL_MIN).",
      });
    }
    logger.info({ owner: schedulerLockOwnerLabel() }, "monitor job lock acquired");
    try {
      const r = await runPriceMonitorJob({
        workerId: "manual-ui",
        maxProducts,
      });
      await setMonitorLastTickAt(new Date());
      return { ok: true, ...r };
    } catch (e) {
      logger.error(e, "monitor run failed");
      return reply.code(500).send({ error: String(e) });
    } finally {
      await releaseSchedulerLock("monitor");
    }
  });

  app.get("/api/monitor/snapshots", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseQueryLimit(q.limit, 100, 500);
    const rows = await prisma.priceSnapshot.findMany({
      take: limit,
      orderBy: { parsedAt: "desc" },
    });
    return { items: rows };
  });

  app.get("/api/monitor/jobs", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseQueryLimit(q.limit, 50, 200);
    const rows = await prisma.syncJob.findMany({
      take: limit,
      orderBy: { startedAt: "desc" },
    });
    return { items: rows };
  });

  app.get("/api/quarantine", async (req, reply) => {
    const auth = await getActiveCabinetToken();
    if (!auth) return reply.code(400).send({ error: "Токен продавца не настроен" });
    try {
      const { nmIds, raw } = await fetchQuarantineGoodsPage(auth.token, 0, 500);
      return {
        count: nmIds.length,
        nmIds,
        note: "Полный ответ WB в raw (усечён в логах админки при необходимости)",
        raw,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(502).send({ error: msg });
    }
  });

  app.get("/api/regions", async () => {
    const raw = loadWbRegions();
    const seen = new Set<string>();
    const items = raw.filter((r) => {
      const d = String(r.dest).trim();
      if (!d || seen.has(d)) return false;
      seen.add(d);
      return true;
    });
    return {
      items,
      hint: "Выбор регионов — вкладка «Регионы». Резерв: REPRICER_WALLET_DEST в .env, если список пуст.",
    };
  });

  app.get("/api/cabinet-uploads", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseQueryLimit(q.limit, 100, 500);
    const rows = await prisma.cabinetPriceUpload.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { product: { select: { nmId: true, title: true } } },
    });
    return { items: rows };
  });

  app.post("/api/jobs/enforce-prices", async (req, reply) => {
    const body = req.body as {
      maxProducts?: number;
      /** по умолчанию true — безопасный прогон; передайте false для реальной выгрузки в кабинет */
      dryRun?: boolean;
      toleranceRub?: number;
      maxPriceStepPercent?: number;
      /** dest региона (см. GET /api/regions); иначе из REPRICER_WALLET_DEST */
      dest?: string;
    };
    const dryRun = body?.dryRun !== false;
    const toleranceRub =
      typeof body?.toleranceRub === "number" && Number.isFinite(body.toleranceRub)
        ? Math.max(0, body.toleranceRub)
        : env.REPRICER_ENFORCE_TOLERANCE_RUB;
    const maxPriceStepPercent =
      typeof body?.maxPriceStepPercent === "number" &&
      Number.isFinite(body.maxPriceStepPercent)
        ? Math.min(90, Math.max(1, body.maxPriceStepPercent))
        : env.REPRICER_ENFORCE_MAX_STEP_PERCENT;
    const primary = await getPrimaryWalletRegion();
    const destRaw =
      body?.dest?.trim() || env.REPRICER_WALLET_DEST.trim() || primary.regionDest || null;
    const { regionDest, regionLabel } = resolveWalletRegionOpts(destRaw);

    const ok = await acquireSchedulerLock("enforce");
    if (!ok) {
      logger.warn({ tag: "enforce_skipped_lock_active" }, "api enforce — lock held");
      return reply.code(409).send({
        error: "Уже выполняется защита цен (lock enforce) или конфликт lock. Подождите завершения.",
      });
    }
    try {
      const r = await runEnforcementJob({
        workerId: "api-enforce",
        maxProducts: body?.maxProducts,
        dryRun,
        toleranceRub,
        maxPriceStepPercent,
        regionDest,
        regionLabel,
      });
      return { ok: true, ...r };
    } catch (e) {
      logger.error(e, "enforce job failed");
      return reply.code(500).send({ error: String(e) });
    } finally {
      await releaseSchedulerLock("enforce");
    }
  });

  app.get("/api/dashboard", async () => {
    const ext = await buildExtendedDashboardPayload();
    const [rulesOff, lastJob] = await Promise.all([
      prisma.minPriceRule.count({ where: { controlEnabled: false } }),
      prisma.syncJob.findFirst({ orderBy: { startedAt: "desc" } }),
    ]);
    return {
      totalProducts: ext.catalog.productCount,
      protectionRulesEnabled: ext.protection.rulesActive,
      protectionRulesDisabled: rulesOff,
      priceRaisesToday: ext.stats.successfulUploadsToday,
      failedOperationsToday: ext.stats.failedAttemptsToday,
      lastSyncJob: lastJob
        ? { id: lastJob.id, type: lastJob.type, status: lastJob.status, startedAt: lastJob.startedAt }
        : null,
      stats: ext.stats,
      seller: ext.seller,
      buyer: ext.buyer,
      catalog: ext.catalog,
      protection: ext.protection,
      publicWalletParse: ext.publicWalletParse,
    };
  });

  app.get("/api/app/settings", async () => {
    const rawRegions = (await getAppSetting("SELECTED_REGION_DESTS")).trim();
    let selectedRegionDests: string[] = [];
    try {
      const p = JSON.parse(rawRegions) as unknown;
      if (Array.isArray(p)) {
        selectedRegionDests = p.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch {
      /* ignore */
    }
    const hours = await getMonitorIntervalHours();
    return {
      GLOBAL_PAUSE: await getAppSetting("GLOBAL_PAUSE"),
      EMERGENCY_STOP: await getAppSetting("EMERGENCY_STOP"),
      MONITOR_INTERVAL_HOURS: hours,
      SELECTED_REGION_DESTS: selectedRegionDests,
    };
  });

  app.patch<{ Body: Record<string, unknown> }>("/api/app/settings", async (req, reply) => {
    const b = req.body ?? {};
    for (const key of ["GLOBAL_PAUSE", "EMERGENCY_STOP"] as const) {
      if (b[key] !== undefined) {
        const v =
          typeof b[key] === "boolean" ? (b[key] ? "true" : "false") : String(b[key]).trim();
        await setAppSetting(key, v);
      }
    }
    let monitorIntervalHoursResponse: number | undefined;
    if (b.monitorIntervalHours !== undefined) {
      const parsed = parseMonitorIntervalHoursInput(b.monitorIntervalHours);
      if (parsed === null) {
        return reply.code(400).send({
          error: `monitorIntervalHours: число от ${MONITOR_INTERVAL_MIN_HOURS} до ${MONITOR_INTERVAL_MAX_HOURS} часов (шаг 0.5)`,
        });
      }
      await setMonitorIntervalHours(parsed);
      monitorIntervalHoursResponse = await getMonitorIntervalHours();
    }
    if (b.selectedRegionDests !== undefined) {
      if (!Array.isArray(b.selectedRegionDests)) {
        return reply.code(400).send({ error: "selectedRegionDests: массив строк dest" });
      }
      await setSelectedRegionDests(b.selectedRegionDests.map((x) => String(x)));
    }
    return {
      ok: true,
      ...(monitorIntervalHoursResponse !== undefined ? { monitorIntervalHours: monitorIntervalHoursResponse } : {}),
    };
  });

  app.patch<{ Body: { monitorIntervalHours?: unknown } }>(
    "/api/settings/monitor-interval",
    async (req, reply) => {
      const parsed = parseMonitorIntervalHoursInput(req.body?.monitorIntervalHours);
      if (parsed === null) {
        return reply.code(400).send({
          error: `monitorIntervalHours: число от ${MONITOR_INTERVAL_MIN_HOURS} до ${MONITOR_INTERVAL_MAX_HOURS} часов (шаг 0.5)`,
        });
      }
      await setMonitorIntervalHours(parsed);
      const monitorIntervalHours = await getMonitorIntervalHours();
      return { ok: true, monitorIntervalHours };
    },
  );

  app.get<{ Params: { id: string } }>("/api/products/:id", async (req, reply) => {
    const raw = req.params.id;
    const nm = Number(raw);
    const qv = req.query as { view?: string; format?: string };
    const wantNormalized = qv.view === "normalized" || qv.format === "normalized";

    const p = await prisma.wbProduct.findFirst({
      where: Number.isFinite(nm) ? { nmId: nm } : { id: raw },
      ...(wantNormalized
        ? {}
        : {
            include: {
              minPriceRule: true,
              fixedPrices: { orderBy: { effectiveFrom: "desc" }, take: 3 },
            },
          }),
    });
    if (!p) return reply.code(404).send({ error: "товар не найден" });
    if (wantNormalized) {
      if (!p.isActive) {
        return reply.code(404).send({ error: "товар не найден" });
      }
      return { item: normalizeWbProductFromDb(p) };
    }
    return p;
  });

  app.get<{ Params: { id: string } }>("/api/products/:id/snapshots", async (req, reply) => {
      const raw = req.params.id;
      const nm = Number(raw);
      const p = await prisma.wbProduct.findFirst({
        where: Number.isFinite(nm) ? { nmId: nm } : { id: raw },
      });
      if (!p) return reply.code(404).send({ error: "товар не найден" });
      const q = req.query as { limit?: string };
      const limit = parseQueryLimit(q.limit, 40, 200);
      const items = await prisma.priceSnapshot.findMany({
        where: { productId: p.id },
        orderBy: { parsedAt: "desc" },
        take: limit,
      });
      return { items };
  });

  app.get<{ Params: { id: string } }>("/api/products/:id/uploads", async (req, reply) => {
      const raw = req.params.id;
      const nm = Number(raw);
      const p = await prisma.wbProduct.findFirst({
        where: Number.isFinite(nm) ? { nmId: nm } : { id: raw },
      });
      if (!p) return reply.code(404).send({ error: "товар не найден" });
      const qu = req.query as { limit?: string };
      const limit = parseQueryLimit(qu.limit, 20, 100);
      const items = await prisma.cabinetPriceUpload.findMany({
        where: { productId: p.id },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return { items };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/products/:id/min-rule",
    async (req, reply) => {
      const raw = req.params.id;
      const nm = Number(raw);
      const p = await prisma.wbProduct.findFirst({
        where: Number.isFinite(nm) ? { nmId: nm } : { id: raw },
      });
      if (!p) return reply.code(404).send({ error: "товар не найден" });
      const b = req.body ?? {};
      const rawMin = b.minAllowedFinalPrice;
      const minP =
        typeof rawMin === "number"
          ? rawMin
          : typeof rawMin === "string"
            ? Number(String(rawMin).replace(",", ".").trim())
            : NaN;
      if (!Number.isFinite(minP) || minP <= 0) {
        return reply.code(400).send({ error: "minAllowedFinalPrice: укажите число > 0 (руб.)" });
      }
      const row = await prisma.minPriceRule.upsert({
        where: { productId: p.id },
        create: {
          productId: p.id,
          minAllowedFinalPrice: minP,
          controlEnabled: b.controlEnabled !== false,
          roundingMode: typeof b.roundingMode === "string" ? b.roundingMode : "integer",
          safetyBufferPercent:
            typeof b.safetyBufferPercent === "number" ? b.safetyBufferPercent : 2,
          maxIncreasePercentPerCycle:
            typeof b.maxIncreasePercentPerCycle === "number"
              ? b.maxIncreasePercentPerCycle
              : 20,
          maxIncreaseAbsolute:
            typeof b.maxIncreaseAbsolute === "number" ? b.maxIncreaseAbsolute : 5000,
          cooldownMinutes: typeof b.cooldownMinutes === "number" ? b.cooldownMinutes : 45,
          minChangeThreshold:
            typeof b.minChangeThreshold === "number" ? b.minChangeThreshold : 5,
          comment: typeof b.comment === "string" ? b.comment : null,
        },
        update: {
          minAllowedFinalPrice: minP,
          ...(typeof b.controlEnabled === "boolean" ? { controlEnabled: b.controlEnabled } : {}),
          ...(typeof b.roundingMode === "string" ? { roundingMode: b.roundingMode } : {}),
          ...(typeof b.safetyBufferPercent === "number"
            ? { safetyBufferPercent: b.safetyBufferPercent }
            : {}),
          ...(typeof b.maxIncreasePercentPerCycle === "number"
            ? { maxIncreasePercentPerCycle: b.maxIncreasePercentPerCycle }
            : {}),
          ...(typeof b.maxIncreaseAbsolute === "number"
            ? { maxIncreaseAbsolute: b.maxIncreaseAbsolute }
            : {}),
          ...(typeof b.cooldownMinutes === "number" ? { cooldownMinutes: b.cooldownMinutes } : {}),
          ...(typeof b.minChangeThreshold === "number"
            ? { minChangeThreshold: b.minChangeThreshold }
            : {}),
          ...(typeof b.comment === "string" ? { comment: b.comment } : {}),
        },
      });
      return { ok: true, rule: row };
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/products/:id/buyer-parse",
    async (req, reply) => {
      const raw = req.params.id;
      const nm = Number(raw);
      const p = await prisma.wbProduct.findFirst({
        where: Number.isFinite(nm) ? { nmId: nm } : { id: raw },
      });
      if (!p) return reply.code(404).send({ error: "товар не найден" });
      const b = req.body ?? {};
      const v = b.buyerParseEnabled;
      if (typeof v !== "boolean") {
        return reply.code(400).send({ error: "buyerParseEnabled: укажите boolean" });
      }
      const row = await prisma.wbProduct.update({
        where: { id: p.id },
        data: { buyerParseEnabled: v },
      });
      return { ok: true, product: { id: row.id, nmId: row.nmId, buyerParseEnabled: row.buyerParseEnabled } };
    },
  );

  app.post<{ Body: { csv?: string } }>("/api/min-prices/import-csv", async (req, reply) => {
    const text = (req.body?.csv ?? "").trim();
    if (!text) return reply.code(400).send({ error: "Передайте csv (тело JSON: { \"csv\": \"...\" })" });
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let imported = 0;
    const errors: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (/^nmid/i.test(line) && line.includes(";")) {
        continue;
      }
      const parts = line.split(/[;\t,]/).map((x) => x.trim());
      const nmId = Number(parts[0]);
      const price = Number(parts[1]?.replace(",", "."));
      if (!Number.isFinite(nmId) || !Number.isFinite(price)) {
        errors.push(`Строка ${i + 1}: неверный формат`);
        continue;
      }
      const prod = await prisma.wbProduct.findFirst({ where: { nmId } });
      if (!prod) {
        errors.push(`Строка ${i + 1}: nmId ${nmId} не в каталоге`);
        continue;
      }
      await prisma.fixedTargetPrice.create({
        data: {
          productId: prod.id,
          nmId,
          targetPrice: price,
          source: "csv",
        },
      });
      await upsertMinPriceRule(prod.id, price, { comment: "csv" });
      imported += 1;
    }
    return { ok: true, imported, errors };
  });

  app.get("/api/audit", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseQueryLimit(q.limit, 100, 500);
    const items = await prisma.auditLog.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return { items };
  });

  app.get("/api/history", async (req) => {
    const q = req.query as { limit?: string };
    const limit = parseQueryLimit(q.limit, 100, 300);
    const [uploads, audits] = await Promise.all([
      prisma.cabinetPriceUpload.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        include: { product: { select: { nmId: true, title: true } } },
      }),
      prisma.auditLog.findMany({
        take: Math.min(limit, 100),
        orderBy: { createdAt: "desc" },
        where: { action: { startsWith: "protection." } },
      }),
    ]);
    return { cabinetUploads: uploads, audit: audits };
  });

  app.post("/api/notifications/telegram-test", async (req, reply) => {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!token || !chat) {
      return reply
        .code(503)
        .send({ error: "Задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в окружении сервера" });
    }
    const body = req.body as { text?: string } | undefined;
    const text = body?.text?.trim() || "Тест: WB защита минимальной цены";
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { ok: res.ok, telegram: data };
  });

  app.post("/api/jobs/run-monitoring", async (req, reply) => {
    const body = req.body as { maxProducts?: number } | undefined;
    const rawMax = body?.maxProducts;
    const maxProducts =
      typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
        ? Math.min(Math.floor(rawMax), 5000)
        : 200;
    const ok = await acquireSchedulerLock("monitor");
    if (!ok) {
      logger.warn({ tag: "monitor_skipped_lock_active" }, "api run-monitoring — lock held");
      return reply.code(409).send({
        error: "Задача уже выполняется (lock monitor). Дождитесь завершения.",
      });
    }
    try {
      let catalogUpserted = 0;
      const auth = await getActiveCabinetToken();
      if (auth) {
        const r = await syncCatalogFromSeller(auth.cabinetId, auth.token);
        catalogUpserted = r.upserted;
      }
      const mon = await runPriceMonitorJob({ workerId: "run-monitoring-api", maxProducts });
      return { ok: true, catalogUpserted, monitor: mon };
    } catch (e) {
      logger.error(e, "run-monitoring failed");
      return reply.code(500).send({ error: String(e) });
    } finally {
      await releaseSchedulerLock("monitor");
    }
  });

  /** Агрегированные «корзины» риска по SKU (dead-letter light). */
  app.get("/api/ops/repricing-risk-buckets", async () => {
    const [
      captcha,
      authWall,
      needsReview,
      belowMin,
      parseFailed,
      safeHold,
      lastGoodUsed,
      walletUnavailableHold,
    ] = await Promise.all([
      prisma.wbProduct.count({ where: { lastWalletParseStatus: "blocked_or_captcha" } }),
      prisma.wbProduct.count({ where: { lastWalletParseStatus: "auth_required" } }),
      prisma.wbProduct.count({ where: { lastEvaluationStatus: "needs_review" } }),
      prisma.wbProduct.count({ where: { lastEvaluationStatus: "below_min" } }),
      prisma.wbProduct.count({ where: { lastEvaluationStatus: "parse_failed" } }),
      prisma.wbProduct.count({ where: { safeModeHold: true } }),
      prisma.wbProduct.count({ where: { lastEvaluationStatus: "last_good_used" } }),
      prisma.wbProduct.count({
        where: { lastEvaluationStatus: "wallet_source_unavailable_safe_hold" },
      }),
    ]);
    return {
      buckets: {
        captcha,
        auth_wall: authWall,
        wallet_marker_or_popup_hint: needsReview,
        below_minimum_observed: belowMin,
        parse_failed: parseFailed,
        safe_mode_hold: safeHold,
        last_good_used: lastGoodUsed,
        wallet_source_unavailable_safe_hold: walletUnavailableHold,
      },
      ts: new Date().toISOString(),
    };
  });
}
