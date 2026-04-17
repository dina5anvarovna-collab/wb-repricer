FROM node:22-bookworm-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3001

# DOM Playwright в этом образе не установлен — для парсинга «Кошелька» на VPS ставьте зависимости
# или соберите отдельный образ с playwright (`npx playwright install --with-deps chromium`).
CMD ["node", "dist/server.js"]
