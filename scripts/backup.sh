#!/bin/bash
# TrendScout v3.0 — Резервное копирование БД

BACKUP_DIR="${BACKUP_DIR:-.backups}"
DB_PATH="${DB_PATH:-.data/trendscout.db}"
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)

# Создать директорию для резервных копий
mkdir -p "$BACKUP_DIR"

# Создать резервную копию
if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "$BACKUP_DIR/trendscout_$BACKUP_DATE.db"
  echo "✅ Резервная копия: $BACKUP_DIR/trendscout_$BACKUP_DATE.db"
  
  # Удалить старые копии (старше 30 дней)
  find "$BACKUP_DIR" -name "trendscout_*.db" -mtime +30 -delete
  echo "✅ Старые резервные копии (>30 дней) удалены"
else
  echo "❌ База данных не найдена: $DB_PATH"
  exit 1
fi
