#!/bin/bash
# TrendScout v3.0 — Проверка статуса системы

echo "🔍 Проверка статуса TrendScout..."
echo ""

if command -v docker-compose &> /dev/null; then
  echo "📦 Контейнеры:"
  docker-compose ps
  echo ""
  
  echo "💾 Использование ресурсов:"
  docker stats --no-stream trendscout-app 2>/dev/null || echo "Контейнер не запущен"
  echo ""
fi

echo "🌐 API Health:"
if curl -s http://localhost:7357/api/health &> /dev/null; then
  curl -s http://localhost:7357/api/health | jq .
else
  echo "❌ API недоступен (localhost:7357)"
fi

echo ""
echo "📊 Статистика:"
if curl -s -H "X-API-Key: $DASHBOARD_API_KEY" http://localhost:7357/api/stats &> /dev/null; then
  curl -s -H "X-API-Key: $DASHBOARD_API_KEY" http://localhost:7357/api/stats | jq .
else
  echo "⚠️  Статистика недоступна (нужен API key)"
fi
