import fs from "node:fs";
import path from "node:path";
import { config as dotenv } from "dotenv";
import { z } from "zod";

const root = process.cwd();
dotenv({ path: path.resolve(root, ".env") });
dotenv({ path: path.resolve(root, ".env.local") });

/** Only for local dev; production must set REPRICER_MASTER_SECRET explicitly. */
const DEV_MASTER_SECRET_FALLBACK =
  "dev-repricer-secret-change-me-in-production-min16";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /**
   * 0.0.0.0 — слушать все IPv4-интерфейсы: работает и с http://127.0.0.1:PORT, и с http://localhost:PORT
   * (на части macOS localhost → ::1, а 127.0.0.1 не принимает IPv6). В закрытой среде задайте HOST=127.0.0.1.
   */
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(3001),
  /** process role: all (api+web+scheduler), api (api only), worker (scheduler only), web (static ui only) */
  REPRICER_PROCESS_MODE: z.enum(["all", "api", "worker", "web"]).default("all"),
  /** Base directories for server runtime data. */
  DATA_DIR: z.string().default("./data"),
  LOG_DIR: z.string().default("./logs"),
  TMP_DIR: z.string().default("./tmp"),
  STORAGE_DIR: z.string().default("./storage"),
  REPRICER_MASTER_SECRET: z
    .string()
    .min(16, "REPRICER_MASTER_SECRET must be at least 16 chars"),
  DATABASE_URL: z.string().default("file:./data/repricer.db"),
  /** Optional seller token from environment (bootstrap on startup). */
  WB_API_TOKEN: z.string().optional().default(""),
  /** Generic dry-run switch for production safety tests. */
  REPRICER_DRY_RUN: z.string().optional().default(""),
  /** Optional monitor interval (hours) fallback if app setting is not initialized. */
  REPRICER_MONITOR_INTERVAL: z.coerce.number().optional(),
  /** Generic browser executable path (Linux server friendly). */
  BROWSER_EXECUTABLE_PATH: z.string().optional().default(""),
  /** Default headless mode for browser actions (1/true/yes = headless). */
  HEADLESS: z.string().optional().default("true"),
  /** Session behavior flags (comma-separated), e.g. login_bootstrap,auto_refresh */
  SESSION_REFRESH_FLAGS: z.string().optional().default(""),
  /** Aliases for buyer storage/profile paths (server-safe naming). */
  BUYER_STATE_PATH: z.string().optional().default(""),
  BUYER_PROFILE_DIR: z.string().optional().default(""),
  /**
   * Абсолютный или относительный путь к persistent Chromium-профилю покупателя WB (приоритет над BUYER_PROFILE_DIR).
   * Пример на сервере: /opt/WB_Repricer/.wb-browser-profile
   */
  WB_BROWSER_PROFILE_DIR: z.string().optional().default(""),
  /**
   * Headless для мониторинга / проверки сессии (1/true = headless). Пусто → HEADLESS.
   */
  WB_BROWSER_HEADLESS: z.string().optional().default(""),
  REPRICER_WEB_DIST_DIR: z.string().default("./apps/web/dist"),
  REPRICER_PUBLIC_DIR: z.string().default("./public"),
  REPRICER_WALLET_CLI_PATH: z.string().default("./dist/walletDom/cli.js"),
  REPRICER_WALLET_PROJECT_ROOT: z.string().default("."),
  REPRICER_BUYER_PROFILE_DIR: z.string().default(".wb-browser-profile"),
  /** Устарело: интервал мониторинга задаётся в админке (AppSetting MONITOR_INTERVAL_HOURS). Поле оставлено для совместимости .env. */
  REPRICER_CRON_SYNC: z.string().default("0 */2 * * *"),
  /** true/1/yes — не запускать плановый мониторинг по таймеру (только кнопка «Мониторинг» в UI). */
  REPRICER_DISABLE_CRON_MONITOR: z.string().optional().default(""),
  /** Параметр `dest` на карточке WB — цена/СПП/«Кошелёк» зависят от региона доставки */
  REPRICER_WALLET_DEST: z.string().optional().default(""),
  REPRICER_ENFORCE_TOLERANCE_RUB: z.coerce.number().min(0).default(3),
  REPRICER_ENFORCE_MAX_STEP_PERCENT: z.coerce.number().min(1).max(90).default(20),
  /** Пусто = cron удержания не запускается. Пример cron: минута 15, каждые 2 ч. */
  REPRICER_CRON_ENFORCE: z.string().optional().default(""),
  /** Для cron-удержания: true = только расчёт + лог, без upload в WB */
  REPRICER_ENFORCE_CRON_DRY_RUN: z.string().optional().default("true"),
  /** Минимальная уверенность парсера кошелька (0..1) для реальной выгрузки цены */
  REPRICER_MIN_WALLET_PARSE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  /** Санити-границы витринной цены относительно sellerBasePrice */
  REPRICER_SHOWCASE_MIN_RATIO_TO_SELLER: z.coerce.number().min(0.1).max(2).default(0.45),
  REPRICER_SHOWCASE_MAX_RATIO_TO_SELLER: z.coerce.number().min(1).max(10).default(1.9),
  /** Допустимый скачок витрины к lastKnownShowcaseRub (%), иначе блок авто-репрайса */
  REPRICER_SHOWCASE_MAX_JUMP_PCT: z.coerce.number().min(5).max(500).default(45),
  /** Предел резкого изменения предлагаемой цены к предыдущему апдейту (%). */
  REPRICER_MAX_PROPOSED_CHANGE_PCT: z.coerce.number().min(5).max(200).default(35),
  /** Лимит авто-апдейтов цены в день на SKU. */
  REPRICER_MAX_UPDATES_PER_DAY_PER_SKU: z.coerce.number().int().min(1).max(50).default(4),
  /** Минимум валидных регионов (HIGH confidence) для авто-репрайса. */
  REPRICER_MIN_VALID_REGIONS_FOR_ENFORCE: z.coerce.number().int().min(1).max(20).default(1),
  /** Нестабильность цены по региону: max spread по 3 последним снимкам (%). */
  REPRICER_REGION_STABILITY_MAX_SPREAD_PCT: z.coerce.number().min(1).max(100).default(20),
  /** Пароль для входа в админку (пусто = без auth) */
  REPRICER_ADMIN_PASSWORD: z.string().optional().default(""),
  /** CORS: через запятую, напр. http://127.0.0.1:5173 (пусто = reflect request origin в dev) */
  REPRICER_CORS_ORIGINS: z.string().optional().default(""),
  /**
   * Пауза после каждого снимка «товар × регион» в мониторинге (мс).
   * Каждый шаг уже поднимает отдельный браузер — большая пауза почти не защитит от лимитов, но сильно растягивает прогон.
   */
  REPRICER_MONITOR_BATCH_PAUSE_MS: z.coerce.number().min(0).max(60_000).default(200),
  /** Таймаут одного вызова wallet CLI в мониторинге (мс). По умолчанию 5 мин — при зависании карточки столько ждём до skip. */
  REPRICER_MONITOR_WALLET_TIMEOUT_MS: z.coerce.number().min(15_000).max(600_000).default(300_000),
  /**
   * Мониторинг: один браузер на весь прогон (Playwright in-process). 0/false/no — старый режим: отдельный процесс на каждый nm×регион.
   */
  REPRICER_MONITOR_WALLET_BATCH: z.string().optional().default("true"),
  /** Пауза между карточками в batch-режиме (мс), снижает риск антибота при быстром перелистывании. */
  REPRICER_MONITOR_BATCH_INTER_STEP_MS: z.coerce.number().min(0).max(30_000).default(1200),
  /**
   * Playwright: таймаут waitForLoadState("networkidle") на карточке WB (мс). 90000 — терпеливо; 25000–35000 — быстрее, чуть выше риск раннего парсинга.
   * WB_WALLET_DOM_SYNC=1 по-прежнему фиксирует 45 с.
   */
  REPRICER_WALLET_NETWORKIDLE_MS: z.coerce.number().min(5_000).max(180_000).default(90_000),
  /**
   * 1/true/yes — не открывать модалку «Детализация цены» на карточке (быстрее, но хуже разбор СПП/кошелька).
   * В production public-first оставьте пустым/false, чтобы сначала витрина, затем popup.
   */
  REPRICER_WALLET_SKIP_PRICE_DETAILS_MODAL: z.string().optional().default(""),
  /**
   * public_only — только публичная карточка + popup (без buyer/cookies/card API).
   * legacy: public_then_cookies — усиление через card при включённом buyer auth.
   */
  REPRICER_WALLET_PARSE_MODE: z.string().optional().default("public_only"),
  /** popup_first — по возможности раньше открывать детализацию цены (флаг для парсера). */
  REPRICER_WALLET_DETAILS_MODE: z.string().optional().default("popup_first"),
  /**
   * true (по умолчанию) — отключить buyer login, storageState, cookies refresh, card.wb.ru как часть основного контура.
   */
  REPRICER_DISABLE_BUYER_AUTH: z.string().optional().default("true"),
  /** TTL блокировки джоб монитор/enforce (мин). После истечения lock можно захватить снова (после падения процесса). */
  REPRICER_SCHEDULER_LOCK_TTL_MIN: z.coerce.number().min(5).max(720).default(90),
  /**
   * Автозапуск окна входа после POST buyer login/start.
   * Пусто = совместимо с REPRICER_BUYER_LOGIN_AUTOSPAWN (по умолчанию только macOS).
   * Явный 0/false — никогда не автозапускать (рекомендуется для VPS).
   */
  REPRICER_BUYER_LOGIN_AUTOSTART: z.string().optional().default(""),
  /**
   * Явное разрешение интерактивного окна браузера (headed) для buyer login CLI.
   * На Linux без DISPLAY по умолчанию запрещено; переопределите true только если есть X11/Wayland forwarding.
   */
  REPRICER_HEADED_LOGIN_ALLOWED: z.string().optional().default(""),
  /**
   * Перед мониторингом не вызывать refresh buyer cookies (только файл на диске как есть).
   * Полезно для VPS public-first без фонового refresh.
   */
  REPRICER_MONITOR_SKIP_COOKIE_REFRESH_BEFORE_JOB: z.string().optional().default(""),
  /** Авто-очистка папки artifacts/wb-wallet: максимум файлов (старые удаляются). */
  REPRICER_WALLET_ARTIFACTS_MAX_FILES: z.coerce.number().min(30).max(10_000).default(300),
  /** Авто-очистка папки artifacts/wb-wallet: срок хранения файлов (часы). */
  REPRICER_WALLET_ARTIFACTS_MAX_AGE_HOURS: z.coerce.number().min(1).max(24 * 90).default(24),
  /**
   * СПП/витрина: после wallet DOM — контур card.wb.ru с куками профиля.
   * Независим от REPRICER_MONITOR_WALLET_BATCH (batch и spawn CLI получают showcase при true).
   */
  /** В public_only обычно false — без кук покупателя нет смысла дергать card.wb.ru. */
  REPRICER_MONITOR_SPP_VIA_COOKIES: z.string().optional().default("false"),
  /** Сколько полных циклов ретраев card.wb.ru (v2+v4) на один nm при fallback */
  REPRICER_MONITOR_CARD_API_MAX_ATTEMPTS: z.coerce.number().min(1).max(6).default(3),
  /** Файл storageState (cookies) для axios/витрины; обновляется refreshSession / Playwright */
  REPRICER_WB_STORAGE_STATE_PATH: z.string().default("./data/wb-buyer-storage-state.json"),
  /** 1/true — раз в час синхронизация каталога из Seller API (токен) */
  REPRICER_CRON_CATALOG_SYNC_HOURLY: z.string().optional().default(""),
  /**
   * Остатки: после цен дергать Statistics API /api/v1/supplier/stocks (нужна категория «Статистика» у ключа).
   * 0/false/off — не вызывать (остаток только из мониторинга/DOM, если добавите иначе).
   */
  REPRICER_SYNC_STATISTICS_STOCKS: z.string().optional().default("true"),
  /** Отдельный токен только со «Статистика»; пусто = тот же, что «Цены и скидки» */
  REPRICER_WB_STATISTICS_TOKEN: z.string().optional().default(""),
  /** Пауза между страницами supplier/stocks (лимит WB 1 запрос/мин) */
  REPRICER_WB_STATISTICS_PAUSE_MS: z.coerce.number().min(61_000).max(180_000).default(61_000),
  /** nmId для buyer session probe (реальная карточка на витрине) */
  REPRICER_BUYER_PROBE_NMID: z.coerce.number().int().positive().default(130_744_302),
  /**
   * 0/false — checkBuyerSession только по главной+кукам (быстро, слабее).
   * 1/true (по умолчанию) — после проверки кук открыть карточку REPRICER_BUYER_PROBE_NMID и убедиться, что парсится цена WB Кошелька.
   */
  REPRICER_BUYER_SESSION_WALLET_PROBE: z.string().optional().default("true"),
  /** Cookie header «валиден» после успешного probe не дольше N минут */
  REPRICER_BUYER_SESSION_TTL_MIN: z.coerce.number().min(5).max(240).default(45),
  /**
   * После «Получить команду для входа»: запустить CLI в фоне (откроется окно браузера).
   * Пусто = на macOS включено, на Linux — выкл.; 1/0 — явно.
   */
  REPRICER_BUYER_LOGIN_AUTOSPAWN: z.string().optional().default(""),
  /**
   * «Подтвердить вход»: если headless-probe не прошёл — повтор с видимым окном.
   * Пусто = на macOS да; 0 — не повторять; 1 — повторять на любой ОС (нужен дисплей).
   */
  REPRICER_BUYER_VERIFY_HEADED_RETRY: z.string().optional().default(""),
  /**
   * strict (по умолчанию) — полная проверка с карточкой товара.
   * cookies_only | server — только главная WB + куки + card (без «толстой» карточки); для VPS без GUI.
   */
  REPRICER_BUYER_VERIFY_MODE: z.string().optional().default(""),

  /** --- Public Playwright parse (PUBLIC ONLY / проба карточки) --- */
  REPRICER_PUBLIC_BROWSER_HEADLESS: z.string().optional().default("true"),
  REPRICER_PUBLIC_BROWSER_CHANNEL: z.enum(["chromium", "chrome"]).default("chromium"),
  /** Пусто — см. REPRICER_DEFAULT_PUBLIC_USER_AGENT в publicBrowserRuntime */
  REPRICER_PUBLIC_BROWSER_USER_AGENT: z.string().optional().default(""),
  REPRICER_PUBLIC_BROWSER_LOCALE: z.string().default("ru-RU"),
  REPRICER_PUBLIC_BROWSER_TIMEZONE: z.string().default("Europe/Moscow"),
  REPRICER_PUBLIC_BROWSER_VIEWPORT_WIDTH: z.coerce.number().min(800).max(2560).default(1366),
  REPRICER_PUBLIC_BROWSER_VIEWPORT_HEIGHT: z.coerce.number().min(600).max(2000).default(900),
  REPRICER_PUBLIC_BROWSER_SLOWMO_MS: z.coerce.number().min(0).max(10_000).default(0),
  REPRICER_PUBLIC_BROWSER_EXTRA_WAIT_MS: z.coerce.number().min(0).max(120_000).default(2000),
  REPRICER_PUBLIC_BROWSER_JITTER_MS: z.coerce.number().min(0).max(30_000).default(3000),
  REPRICER_PUBLIC_PARSE_DEBUG: z.string().optional().default("false"),
  /** Пусто → {TMP_DIR}/public-parse-debug */
  REPRICER_PUBLIC_PARSE_DEBUG_DIR: z.string().optional().default(""),
  REPRICER_PUBLIC_PROXY_SERVER: z.string().optional().default(""),
  REPRICER_PUBLIC_PROXY_USERNAME: z.string().optional().default(""),
  REPRICER_PUBLIC_PROXY_PASSWORD: z.string().optional().default(""),
});

export type AppEnv = z.infer<typeof schema>;

function buildProcessEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  const nodeEnv = (merged.NODE_ENV as AppEnv["NODE_ENV"] | undefined) ?? "development";
  merged.NODE_ENV = nodeEnv;

  const explicitSecret = merged.REPRICER_MASTER_SECRET?.trim();
  if (nodeEnv === "production" && !explicitSecret) {
    throw new Error(
      "REPRICER_MASTER_SECRET is required in production (set in .env or environment).",
    );
  }
  merged.REPRICER_MASTER_SECRET = explicitSecret || DEV_MASTER_SECRET_FALLBACK;

  if (!merged.DATABASE_URL?.trim()) {
    merged.DATABASE_URL = "file:./data/repricer.db";
  }
  if (!merged.DATA_DIR?.trim()) {
    merged.DATA_DIR = "./data";
  }
  if (!merged.LOG_DIR?.trim()) {
    merged.LOG_DIR = "./logs";
  }
  if (!merged.TMP_DIR?.trim()) {
    merged.TMP_DIR = "./tmp";
  }
  if (!merged.STORAGE_DIR?.trim()) {
    merged.STORAGE_DIR = "./storage";
  }
  if (!merged.BUYER_STATE_PATH?.trim()) {
    merged.BUYER_STATE_PATH = merged.REPRICER_WB_STORAGE_STATE_PATH?.trim() || "./data/wb-buyer-storage-state.json";
  }
  const wbBrowserProfile = merged.WB_BROWSER_PROFILE_DIR?.trim();
  if (wbBrowserProfile) {
    merged.BUYER_PROFILE_DIR = wbBrowserProfile;
    merged.REPRICER_BUYER_PROFILE_DIR = wbBrowserProfile;
  }
  if (!merged.BUYER_PROFILE_DIR?.trim()) {
    merged.BUYER_PROFILE_DIR = merged.REPRICER_BUYER_PROFILE_DIR?.trim() || "./.wb-browser-profile";
  }
  if (merged.REPRICER_DRY_RUN?.trim()) {
    merged.REPRICER_ENFORCE_CRON_DRY_RUN = merged.REPRICER_DRY_RUN;
  }

  /** Локально по умолчанию отключаем плановый мониторинг — иначе долгий фон держит lock и ручная кнопка даёт 409. В .env можно задать REPRICER_DISABLE_CRON_MONITOR=false. */
  if (nodeEnv !== "production" && !merged.REPRICER_DISABLE_CRON_MONITOR?.trim()) {
    merged.REPRICER_DISABLE_CRON_MONITOR = "true";
  }

  return merged;
}

export const env: AppEnv = schema.parse(buildProcessEnv());

if (process.env.NODE_ENV !== "production" && !process.env.REPRICER_MASTER_SECRET?.trim()) {
  // eslint-disable-next-line no-console
  console.warn(
    "[repricer] REPRICER_MASTER_SECRET not set — using insecure dev default. Set REPRICER_MASTER_SECRET in .env for real use.",
  );
}

// Prisma reads DATABASE_URL from process.env at query time
process.env.DATABASE_URL = env.DATABASE_URL;

const dataDir = path.resolve(root, env.DATA_DIR);
const logDir = path.resolve(root, env.LOG_DIR);
const tmpDir = path.resolve(root, env.TMP_DIR);
const storageDir = path.resolve(root, env.STORAGE_DIR);
for (const dir of [dataDir, logDir, tmpDir, storageDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
