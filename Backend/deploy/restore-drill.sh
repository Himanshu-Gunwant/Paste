#!/usr/bin/env bash
# Backup/restore drill (docs/OPERATIONS.md §5, quarterly per the architecture).
# Restores the latest dump into a THROWAWAY database and verifies table counts.
# Usage: ./deploy/restore-drill.sh [backup_file]
set -euo pipefail

BACKUP_DIR="${1:-/var/backups/paste}"
LATEST="$(ls -t "$BACKUP_DIR"/paste_*.dump.gz 2>/dev/null | head -1)"
if [ -z "${LATEST:-}" ]; then
  echo "no backups found in $BACKUP_DIR — run deploy/backup.sh first"
  exit 1
fi
echo "==> drilling restore of $LATEST"

if command -v docker > /dev/null && docker ps --format '{{.Names}}' | grep -q 'postgres'; then
  CONTAINER="$(docker ps --format '{{.Names}}' | grep postgres | head -1)"
  docker exec "$CONTAINER" psql -U paste -d paste -c "DROP DATABASE IF EXISTS paste_restore;" -c "CREATE DATABASE paste_restore;"
  gunzip -c "$LATEST" | docker exec -i "$CONTAINER" pg_restore -U paste -d paste_restore --no-owner
  COUNTS="$(docker exec "$CONTAINER" psql -U paste -d paste_restore -t -c \
    "SELECT count(*) FROM pg_tables WHERE schemaname='public';")"
  USERS="$(docker exec "$CONTAINER" psql -U paste -d paste_restore -t -c "SELECT count(*) FROM users;")"
  PASTES="$(docker exec "$CONTAINER" psql -U paste -d paste_restore -t -c "SELECT count(*) FROM pastes;")"
  docker exec "$CONTAINER" psql -U paste -d paste -c "DROP DATABASE IF EXISTS paste_restore;" > /dev/null
else
  echo "docker postgres not found; production drill runs pg_restore against a scratch database"
  exit 1
fi

echo "==> restored: tables=$COUNTS users=$USERS pastes=$PASTES"
if [ "$(echo "$COUNTS" | tr -d ' ')" -lt 10 ]; then
  echo "RESTORE DRILL FAILED — table count suspiciously low"
  exit 1
fi
echo "==> RESTORE DRILL PASSED"
