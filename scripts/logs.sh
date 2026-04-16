#!/bin/bash
# TrendScout v3.0 — Просмотр логов

if command -v docker-compose &> /dev/null; then
  docker-compose logs -f "$@"
else
  tail -f logs/trendscout.log
fi
