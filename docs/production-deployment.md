# WB Repricer Production Deployment

## 1) Build

```bash
npm ci
npm run build:all
```

## 2) Required Linux packages

- Node.js 20+
- sqlite3 runtime
- Playwright dependencies:
  - `npx playwright install chromium` (or install Google Chrome and set `BROWSER_EXECUTABLE_PATH`)
  - for Debian/Ubuntu also run `npx playwright install-deps chromium`

## 3) Required directories

Create and grant write permissions to service user:

- `/opt/wb-repricer/data`
- `/opt/wb-repricer/logs`
- `/opt/wb-repricer/tmp`
- `/opt/wb-repricer/storage`

Use `.env.production.example` as template.

## 4) Process modes

- `start` -> all-in-one (`api + web + scheduler`)
- `start:api` -> API only
- `start:web` -> static UI only
- `start:worker` -> scheduler/monitor/enforce worker only

Examples:

```bash
npm run start:api
npm run start:web
npm run start:worker
```

## 5) Safe rollout (recommended)

Set:

- `REPRICER_DRY_RUN=true`
- `REPRICER_ENFORCE_CRON_DRY_RUN=true`

In this mode monitoring and decisions run, but seller cabinet price uploads are not executed.

## 6) Health checks

- `GET /health`
- `GET /health/db`
- `GET /health/browser`
- `GET /health/buyer-session`
- `GET /health/storage`

## 7) Buyer session flow (server)

Two modes are supported:

- bootstrap/login/refresh session (manual login/import)
- normal monitor mode using persisted buyer state (`BUYER_STATE_PATH`) and profile (`BUYER_PROFILE_DIR`)

For headless servers use:

- `REPRICER_BUYER_VERIFY_MODE=cookies_only`
- import storage state JSON after manual login from workstation.

## 8) DB and migrations

SQLite is used by default (`DATABASE_URL=file:...`).

Use:

```bash
npx prisma migrate deploy
```

Optional first-time setup:

```bash
npx prisma db push
```

## 9) PM2 example

```bash
pm2 start npm --name wb-repricer-api -- run start:api
pm2 start npm --name wb-repricer-web -- run start:web
pm2 start npm --name wb-repricer-worker -- run start:worker
pm2 save
```

## 10) systemd example (worker)

`/etc/systemd/system/wb-repricer-worker.service`

```ini
[Unit]
Description=WB Repricer Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wb-repricer
EnvironmentFile=/opt/wb-repricer/.env
ExecStart=/usr/bin/npm run start:worker
Restart=always
RestartSec=5
User=wb
Group=wb

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wb-repricer-worker
```

## 11) First-run verification checklist

1. `/health`, `/health/db`, `/health/storage` are `ok: true`.
2. `/health/browser` is `ok: true` (browser executable works).
3. `/health/buyer-session` has active session and saved state.
4. `GET /api/settings/status` shows seller token configured/valid.
5. Run monitor job and confirm `monitor job done` log.
6. Confirm repricing decisions appear in catalog.
7. With dry-run enabled verify no `cabinet price upload submitted`.
8. Disable dry-run only after decision quality is validated.
