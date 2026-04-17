# План рефакторинга (по файлам)

## Backend

| Область | Файлы |
|--------|--------|
| Схема БД | `prisma/schema.prisma` — снимки, обогащение каталога, reason codes, история min, batch, UI audit |
| Конфиг | `src/config/env.ts` — CORS, пароль админки, порог confidence кошелька |
| HTTP | `src/http/apiResponse.ts`, `src/http/adminAuth.ts` — единый формат ответов (частично), сессия по Bearer |
| Сервисы | `src/services/dashboardService.ts` — дашборд + статус WB |
| Репозитории | `src/repositories/catalogRepository.ts` — список с фильтрами, bulk |
| WB API | `src/modules/wbSellerApi/client.ts` — разбор Content API (`data.cards`), `fetchContentCardsMapBestEffort` |
| Синк | `src/modules/catalogSync/syncCatalog.ts` — цены + обогащение карточками |
| Парсер | `src/walletDom/wbWalletPriceParser.ts` — статусы, confidence, JSON-LD, блокировки страницы |
| CLI обёртка | `src/modules/wbBuyerDom/runWalletCli.ts` — новые поля JSON |
| Мониторинг | `src/modules/priceMonitor/runMonitor.ts` — evaluation, поля снимка, денормализация на товар |
| Движок | `src/modules/priceProtection/engine.ts`, `reasonCodes.ts` — режим enforcement только по кошельку |
| Удержание | `src/modules/priceEnforcement/runEnforcementJob.ts` — confidence, reasonCode в upload |
| Маршруты | `src/routes/api.ts` — новые endpoints (последующий шаг: разнести по `routes/*.ts`) |
| Сервер | `src/server.ts` — CORS, SPA из `apps/web/dist`, fallback `index.html` |

## Frontend

| Область | Файлы |
|--------|--------|
| Приложение | `apps/web/` — Vite, React 19, Tailwind v4, TanStack Query/Table, Zustand persist, Radix Dialog |
| Вход | `apps/web/src/pages/LoginPage.tsx`, `store/session.ts` |
| Разделы | `pages/*`, `components/Shell.tsx`, `App.tsx` |

## Что заменено

- Основной UI: вместо монолитного `public/admin.html` — SPA в `apps/web` (старый `admin.html` можно не использовать).
- Синк каталога: заголовки из Content API вместо `nm 123`.
- Парсер: явные статусы и confidence; кошелёк не подменяется ценой витрины без статуса.
- Удержание: расчёт «ниже минимума» только по цене кошелька; низкая confidence → без upload.

## Оставшиеся риски

- Вёрстка WB и JSON-LD меняются — парсер потребует обновлений.
- Content API может отличаться по форме ответа — поддержаны варианты с `cards` в корне и внутри `data`.
- SQLite и один процесс — сессии админки в памяти сбрасываются при перезапуске.
- Маршруты API всё ещё в одном большом `api.ts` — разбиение на файлы без изменения путей можно сделать итеративно.
