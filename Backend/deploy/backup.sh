#!/usr/bin/env bash
# Nightly PostgreSQL backup (docs/OPERATIONS.md — cron 03:00, S3 sync).
# Usage: ./deploy/backup.sh [backup_dir] [keep_days]
set -euo pipefail

BACKUP_DIR="${1:-/var/backups/paste}"
KEEP_DAYS="${2:-30}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/paste_$STAMP.dump.gz"

mkdir -p "$BACKUP_DIR"

if command -v docker > /dev/null && docker ps --format '{{.Names}}' | grep -q 'postgres'; then
  # Dev/CI path — dump through the running container.
  CONTAINER="$(docker ps --format '{{.Names}}' | grep postgres | head -1)"
  docker exec "$CONTAINER" pg_dump -U paste -Fc paste | gzip > "$OUT"
else
  # VPS production path — local pg_dump with DATABASE_URL from the app env.
  set -a; [ -f "$(dirname "$0")/../.env" ] && . "$(dirname "$0")/../.env"; set +a
  pg_dump -Fc "$DATABASE_URL" | gzip > "$OUT"
fi

# Retention window.
find "$BACKUP_DIR" -name 'paste_*.dump.gz' -mtime +"$KEEP_DAYS" -delete

SIZE="$(du -h "$OUT" | cut -f1)"
echo "backup written: $OUT ($SIZE)"
# Production: aws s3 cp "$OUT" "s3://$S3_BACKUP_BUCKET/" --storage-class STANDARD_IA
