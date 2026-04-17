# Соответствие ТЗ «Marketparser-подобная защита минимальной цены»

Текущая кодовая база — **WB_Repricer** (Fastify + Prisma + SQLite). Ниже — честное сопоставление с вашим ТЗ.

## Реализовано (работает в коде)

| Требование | Реализация |
|------------|------------|
| Подключение кабинета WB, токен, тест | `POST /api/wb/connect`, `POST /api/settings/wb-token`, `POST /api/settings/wb-token/test`; токен **AES-GCM** в БД |
| Синхронизация товаров и цен из кабинета | `POST /api/wb/sync`, `POST /api/catalog/sync`; база, скидка, **оценка цены после скидки** в `discountedPriceRub` |
| Минимальная итоговая цена на товар | Модель **MinPriceRule** + синхронизация с `POST /api/fixed-prices/set` и импортом |
| Импорт мин. цен CSV | `POST /api/min-prices/import-csv` (`{ "csv": "nmId;price\\n..." }`) |
| Редактирование правила | `PATCH /api/products/:id/min-rule` (`id` = cuid или **nmId**) |
| Observed mode движок | `src/modules/priceProtection/engine.ts`: коэффициент **observedFinal/base**, буфер, округления, лимиты, cooldown |
| Только **подъём** базы при нарушении min | Джоб защиты не снижает цену |
| Парсинг итоговой цены (кошелёк) | Playwright CLI + регион `dest` |
| Регионы витрины | `data/wb-regions.json`, `GET /api/regions`, `REPRICER_WALLET_DEST` |
| Автоподъём в кабинет | `POST /api/jobs/enforce-prices` (`dryRun: false`) |
| Глобальная пауза / стоп | `AppSetting` + `GET/PATCH /api/app/settings` (`GLOBAL_PAUSE`, `EMERGENCY_STOP`) |
| Аудит изменений цены | `AuditLog` + `writeAuditLog` в джобе; `GET /api/audit`, `GET /api/history` |
| Карантин WB | `GET /api/quarantine` → `fetchQuarantineGoodsPage` |
| Мониторинг по расписанию | Интервал из настроек БД `MONITOR_INTERVAL_HOURS` (проверка раз в минуту); опционально `REPRICER_CRON_ENFORCE` (env) для защиты цен |
| Ручной прогон мониторинга | `POST /api/jobs/run-monitoring` (синк каталога + снимки) |
| Docker / compose | `Dockerfile`, `docker-compose.yml` |
| Тесты движка | `npm test` (Vitest) |

## Частично / упрощённо

| Требование | Статус |
|------------|--------|
| Next.js админка | Пока **одностраничная** русская админка `public/admin.html` (без отдельного Next-проекта) |
| PostgreSQL / Redis / BullMQ | Пока **SQLite** и **cron**; миграция на Postgres — смена `DATABASE_URL` + провайдер Prisma |
| Проверка статуса upload по `uploadID` (poll) | Отправка задачи есть; **ожидание обработки WB** — следующий этап |
| Размерные цены (`upload/task/size`) | Не реализовано |
| Excel (.xlsx) | Только **CSV** в JSON; Excel — конвертация в CSV или будущий пакет `xlsx` |
| Email / Telegram | **Тест Telegram:** `POST /api/notifications/telegram-test` + кнопка в `admin.html` (нужны `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Полная подсистема событий и email — не реализована |
| Auth пользователей / роли | Один кабинет без логина (для внутреннего VPS закрыть сеть/firewall/basic auth nginx) |
| Formula mode WB | Заготовка под расширение; в проде опираемся на **observed** + DOM |

## Не сделано (вне текущего объёма)

- Отдельный репозиторий NestJS + Next + Redis, как в «идеальной» архитектуре ТЗ.
- Полные integration-тесты с моком WB HTTP (можно добавить на `msw` / `nock`).
- ESLint/Prettier в репозитории (по желанию — `eslint.config.js`).

## Главное бизнес-правило

Если **наблюдаемая итоговая цена** (кошелёк → скидка кабинета → база) **ниже** `minAllowedFinalPrice`, движок считает новую **базовую** цену (observed mode + буфер + округление + лимиты) и джоб отправляет её в **WB upload/task** (при `dryRun: false`).
