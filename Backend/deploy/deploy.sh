#!/usr/bin/env bash
# Tagged-release deploy for the VPS (docs/ARCHITECTURE.md §17).
# Usage: ./deploy/deploy.sh <git-tag>
set -euo pipefail

TAG="${1:?usage: deploy.sh <tag>}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

PREVIOUS_REF="$(git rev-parse HEAD)"
HEALTH_URL="http://127.0.0.1:3000/readyz"

echo "==> deploying ${TAG}"
git fetch --tags origin
git checkout --force "$TAG"

echo "==> install + build"
npm ci
npm run build

echo "==> migrations"
npx prisma migrate deploy

echo "==> reload processes"
pm2 reload deploy/ecosystem.config.cjs --update-env

echo "==> health gate"
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "==> deploy healthy: ${TAG}"
    exit 0
  fi
  sleep 2
done

echo "==> health gate FAILED — rolling back to ${PREVIOUS_REF}"
git checkout --force "$PREVIOUS_REF"
npm ci
npm run build
npx prisma migrate deploy
pm2 reload deploy/ecosystem.config.cjs --update-env
echo "==> rollback complete; deploy of ${TAG} aborted"
exit 1
