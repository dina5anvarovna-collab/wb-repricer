# WB Repricer — контроль цен (Node.js / TypeScript)

**Зона продукта (только эта папка):** парсинг и учёт цен для Wildberries — цена в кабинете продавца, цена на витрине **WB Кошелёк** (DOM), хранение **целевой цены** и **мониторинг** (снимки, отклонения от цели).  

**Сюда намеренно не входит:** учёт прибыли, себестоимость, маржа, матрица юнит-экономики, отчёты по продажам — это отдельные проекты (например `WB_Profit_Ready`). Связь с ними не обязательна.

Граница репозиториев для деплоя и команд: [docs/PROJECT_BOUNDARY.md](docs/PROJECT_BOUNDARY.md).

Проект вынесен из **WB Price Guard** и живёт **только** в `WB_Repricer`.

### Где вести разработку

**Вся логика repricer и Playwright wallet CLI** (`src/**`, в т.ч. `src/walletDom/`) ведётся **только в каталоге**  
`/Users/dinakasaeva/Downloads/WB_Repricer`  
(откройте эту папку как **корень workspace** в Cursor).  
Любые правки по этому сервису и DOM-парсеру кошелька — **здесь**, а не в `WB_Profit_Ready`. Дубликат CLI в другом проекте при необходимости обновляют вручную копированием из `src/walletDom/`.

## Структура

```
WB_Repricer/
  data/                     # SQLite (repricer.db), wb-regions.json (dest регионов)
  prisma/schema.prisma
  src/
    config/env.ts
    walletDom/              # Playwright CLI «WB Кошелёк» (раньше в корне Price Guard)
      cli.ts
      wbWalletPriceParser.ts
    lib/
    modules/wbBuyerDom/     # spawn dist/walletDom/cli.js
    modules/catalogSync/
    modules/priceMonitor/
    modules/priceEnforcement/ # джоб удержания цены → upload в кабинет WB
    modules/scheduler/
    routes/api.ts
    server.ts
  public/index.html
```

| Слой | Источник | Назначение |
|------|----------|------------|
| **Seller** | WB seller API token (AES at rest) | каталог, цены/скидки кабинета, nmId |
| **Buyer** | Playwright persistent profile + DOM (public-first; cookies fallback) | фактическая цена **WB Кошелёк** (`dest` = регион витрины); вход покупателя опционален |
| **Enforce** | discounts-prices `POST /api/v2/upload/task` | подгонка **цены до скидки** в кабинете под цель по кошельку |

## Локальный запуск

```bash
cd /path/to/WB_Repricer
cp .env.example .env
# Задайте REPRICER_MASTER_SECRET (≥16 символов) для серьёзного использования

npm install
cd apps/web && npm install && cd ..
npx playwright install chromium
npx prisma generate
npx prisma db push
npm run build:all
npm run dev
# API: http://127.0.0.1:3001   health: GET /health
```

**Панель (React):** в другом терминале `npm run dev:web` → http://127.0.0.1:5173 (прокси `/api` на :3001).  
**Прод без Vite:** после `npm run build:all` сервер отдаёт собранный UI с корня (`apps/web/dist`), если каталог существует.

Production: `NODE_ENV=production npm run build:all && node dist/server.js`

### Деплой на Ubuntu (VPS / systemd)

1. Скопируйте проект в каталог (например `/opt/WB_Repricer`), создайте `data`, `logs`, `tmp`, `storage` при необходимости (сервер создаёт их при старте).
2. `cp .env.example .env` → задайте `REPRICER_MASTER_SECRET`, `NODE_ENV=production`, `REPRICER_WALLET_PROJECT_ROOT=/opt/WB_Repricer`, при желании `REPRICER_DISABLE_CRON_MONITOR=true` до первого ручного прогона.
3. Установка и сборка:

```bash
cd /opt/WB_Repricer
npm run install:all
npx playwright install chromium
npx prisma db push
npm run build:all
sudo systemctl restart wb-repricer
```

4. Проверка: `GET http://SERVER_IP:3001/health`, UI на порту приложения.
5. Buyer-login на сервере **не обязателен**, если достаточно только **public-first** парсинга (`REPRICER_DISABLE_BUYER_AUTH=true` по умолчанию). Чтобы использовать **persistent-профиль покупателя** на VPS и стабильный парсинг кошелька через сохранённые cookies:

### Вход покупателя WB на сервере (Linux, один раз)

Нужна **графическая среда** для окна браузера: например `ssh -X user@host` с XQuartz/X11 на клиенте, или виртуальный дисплей (`xvfb-run`).

1. Подключитесь по SSH к серверу, перейдите в каталог проекта:  
   `cd /opt/WB_Repricer` (или ваш путь).
2. В `.env` задайте:
   - `REPRICER_DISABLE_BUYER_AUTH=false` — включить контур покупателя;
   - `WB_BROWSER_PROFILE_DIR=/opt/WB_Repricer/.wb-browser-profile` — **один** постоянный каталог профиля Chromium (Playwright `launchPersistentContext`);
   - опционально `WB_BROWSER_HEADLESS=true` — мониторинг и CLI-парсинг без окна после логина.
3. Установите Chromium для Playwright: `npx playwright install chromium`.
4. Сборка: `npm run build`.
5. Запуск интерактивного входа:
   ```bash
   npm run wallet:login
   ```
   Откроется браузер — войдите в аккаунт WB на главной странице. После успешного входа закройте процесс (Ctrl+C в терминале после закрытия вкладки при необходимости). Профиль и cookies остаются в `WB_BROWSER_PROFILE_DIR`.
6. Запустите приложение как обычно (`node dist/server.js` или systemd). Мониторинг использует **тот же** профиль в **headless**, без повторного логина.

Если сессия истечёт, в логах будет `buyer_session_stale` и мониторинг временно перейдёт на **эфемерный public-style** парсинг (без автологина); safe mode и last-good не отключаются.

Ручная альтернатива без CLI-окна: импорт `storageState` или ZIP профиля — `POST /api/settings/buyer-session/import-storage-state`, `POST /api/settings/buyer-session/import-profile-archive`.

### Сессии и данные WB (production-like, личное использование)

| Уровень | Что используется | Где хранится |
|--------|-------------------|--------------|
| **1** | Seller API **токен** (официально) — каталог, цены, остаток в `WbProduct` | `SellerCabinet.tokenEncrypted` |
| **2** | Браузер **Playwright**: persistent profile (`WB_BROWSER_PROFILE_DIR` или `REPRICER_BUYER_PROFILE_DIR`) + опционально **storageState** JSON | профиль на диске; cookies в `REPRICER_WB_STORAGE_STATE_PATH` |
| **3** | UI «Сессия WB»: проверка, **Обновить cookies** (фон/окно), CLI-вход | таблица `AuthSession` (метаданные проверок) |

- **session-manager:** `src/modules/wbSession/sessionManager.ts` — `loadSavedSession`, `saveSession`, `getValidCookies`, `refreshSessionIfNeeded`, `isBrowserCookieSessionAlive`, `exportCookieHeader`, `normalizeCookies`, синхронизация метаданных в `AuthSession`.
- **HTTP (axios):** `src/modules/wbPortalApi/wbAxiosClient.ts` — `createWbShowcaseAxios()` (Cookie из storageState), `createWbSellerApiAxios(token)`, `withNetworkRetries`.
- **Конфиг URL:** `src/config/wbEndpoints.ts`.
- **Нормализация:** `src/modules/wbData/normalizeProduct.ts`, сводка `mergeProductData.ts`.
- **Синхронизация + лог:** `src/modules/wbSync/unifiedSyncService.ts`, `SyncRunLog`, снимки `ProductPriceRecord` / `ProductStockLine`.
- **API:** `src/routes/unifiedWbRoutes.ts` — `/api/auth/status|check|refresh|login/start`, `/api/products`, `/api/stocks`, `/api/prices`, `/api/discounts`, `/api/sync/*`, `/api/logs`.
- **Плановый каталог:** `REPRICER_CRON_CATALOG_SYNC_HOURLY=true` — раз в час `runUnifiedSync("all")` (см. `src/modules/scheduler/cron.ts`).

### macOS

1. Установите Node ≥ 20, выполните шаги из «Локальный запуск».
2. Для Chrome в Playwright: `REPRICER_DOM_BROWSER=chrome` или `npx playwright install chrome`.
3. Первый вход покупателя: **Сессия WB** → «Запустить вход в WB (CLI)» или `npm run wallet:login`.

### Что изменилось в архитектуре (кратко)

- Новый фронт: `apps/web` (Vite + React + Tailwind + TanStack Table/Query + Zustand). Старый `public/admin.html` больше не основной интерфейс.
- Синк каталога подмешивает **Content API** (название, бренд, предмет, артикул).
- DOM-парсер кошелька: **статусы** (`wallet_found`, `only_regular_found`, …), **confidence**, JSON-LD; реальная выгрузка в кабинет только при достаточной уверенности (`REPRICER_MIN_WALLET_PARSE_CONFIDENCE`).
- Опционально: `REPRICER_ADMIN_PASSWORD` + `POST /api/auth/login` → `Authorization: Bearer …` для остальных `/api/*` (кроме сохранения токена продавца).
- План по файлам и риски: [docs/REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md).

### Переменные окружения

- `REPRICER_WALLET_CLI_PATH` — по умолчанию `./dist/walletDom/cli.js`
- `REPRICER_WALLET_PROJECT_ROOT` — `.` (корень `WB_Repricer`, cwd для `node` при запуске CLI)
- `WB_BROWSER_PROFILE_DIR` — приоритетный путь к persistent-профилю покупателя (например `/opt/WB_Repricer/.wb-browser-profile`); иначе `REPRICER_BUYER_PROFILE_DIR` / `.wb-browser-profile`
- `WB_BROWSER_HEADLESS` — если задан, переопределяет headless для мониторинга и CLI-парсера кошелька (иначе используется `HEADLESS`)
- `REPRICER_BUYER_PROFILE_DIR` — `.wb-browser-profile` (относительно корня проекта), если `WB_BROWSER_PROFILE_DIR` не задан
- `REPRICER_CRON_SYNC` — cron мониторинга, по умолчанию каждые 2 часа
- `REPRICER_WALLET_DEST` — `dest` региона для карточки WB (список: `GET /api/regions` или `data/wb-regions.json`)
- `REPRICER_ENFORCE_TOLERANCE_RUB`, `REPRICER_ENFORCE_MAX_STEP_PERCENT` — допуск к цели и лимит шага цены в кабинете за один проход
- `REPRICER_CRON_ENFORCE` — опциональный cron джоба удержания; `REPRICER_ENFORCE_CRON_DRY_RUN=true` по умолчанию (без upload)

### Buyer login (один раз)

```bash
cd /path/to/WB_Repricer
npm run build
npx playwright install chromium
node dist/walletDom/cli.js --login=true --headless=false --userDataDir="./.wb-browser-profile" --browser=chrome
```

Далее в API: `POST /api/settings/buyer-session/login/start` → выполнить `cliCommand` → `POST .../login/finish`.

### Типовой сценарий API

1. `POST /api/settings/wb-token` `{ "token": "..." }`
2. `POST /api/catalog/sync`
3. `POST /api/fixed-prices/set` `{ "nmId": 123, "targetPrice": 999 }`
4. `GET /api/regions` — выбрать `dest` (Москва `-1257786`, СПб `-1059500`, …)
5. Задать в `.env` `REPRICER_WALLET_DEST` (тот же `dest`), чтобы мониторинг снимал цену **в нужном регионе**
6. `POST /api/monitor/run` `{ "maxProducts": 10 }`
7. `GET /api/monitor/snapshots`

### Удержание цены (джоб + выгрузка в кабинет WB)

**Цель `targetPrice`** интерпретируется как желаемая цена **«WB Кошелёк»** на карточке (после СПП/кошелька в том виде, как отдаёт витрина для выбранного `dest`).

1. Сначала прогон с `dryRun` (по умолчанию для `POST /api/jobs/enforce-prices` **включён**, пока явно не передать `"dryRun": false`):

   `POST /api/jobs/enforce-prices`  
   `{"dryRun": true, "dest": "-1257786", "maxProducts": 20, "toleranceRub": 3, "maxPriceStepPercent": 20}`

2. Реальная выгрузка цены в кабинет (тот же токен продавца, API **discounts-prices**):

   `POST /api/jobs/enforce-prices`  
   `{"dryRun": false, "dest": "-1257786"}`

Алгоритм одного товара: парсим кошелёк → если отклонение от цели больше `toleranceRub`, читаем текущую цену до скидки и % скидки из WB → считаем `newPrice ≈ round(price * target/wallet)`, ограничиваем ±`maxPriceStepPercent`%, отсекаем слишком резкое снижение (риск **карантина** WB) → `POST /api/v2/upload/task` с тем же `discount`. История: `GET /api/cabinet-uploads`.

Опционально задайте `REPRICER_CRON_ENFORCE` и при готовности выставьте `REPRICER_ENFORCE_CRON_DRY_RUN=false` для автоматического удержания по расписанию.

**Ограничения:** обратный расчёт «кошелёк ↔ цена в кабинете» приближённый (СПП/акции WB меняются); сложные товары с ценой по размерам (`upload/task/size`) здесь не обрабатываются.

## Связь с WB Price Guard

- **WB_Profit_Ready** — свой `dist/cli.js` в корне для Python-синка; код CLI дублируется в `src/walletDom/` здесь, чтобы **Repricer был автономным**.
- При изменении логики парсера имеет смысл править оба места или вынести общий пакет позже.

## Компромиссы и риски

- Каталог тянет в основном prices filter; названия вида `nm {id}` — заглушка.
- Селекторы WB DOM ломаются при смене вёрстки.
- Резкое снижение цены может попасть в **карантин** WB; джоб частично ограничивает шаг и проверяет «пол» от цены.
- SQLite на одном хосте; масштаб — PostgreSQL + миграции Prisma.
