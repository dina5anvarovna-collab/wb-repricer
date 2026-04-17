#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
git pull
npm install
npm install --prefix apps/web
npx prisma generate
npx prisma db push
npm run build
npm run build:web
echo "Deploy build OK. Restart systemd unit, e.g.: sudo systemctl restart wb-repricer"
