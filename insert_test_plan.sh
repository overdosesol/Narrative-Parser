#!/bin/sh
sqlite3 /data/trendscout.db "INSERT OR REPLACE INTO plans (id, name, price_usd, sources, alert_limit, history_days, api_access) VALUES (999, 'test', 1, 'reddit,google_trends', 10, 1, 0);"
echo "Done. Plans in DB:"
sqlite3 /data/trendscout.db "SELECT id, name, price_usd FROM plans;"
