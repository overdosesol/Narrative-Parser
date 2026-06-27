#!/bin/bash
# Catalyst v3.0 — Проверка статуса системы

echo "🔍 Проверка статуса Catalyst..."
echo ""

if command -v docker-compose &> /dev/null; then
  echo "📦 Контейнеры:"
  docker-compose ps
  echo ""
  
  echo "💾 Использование ресурсов:"
  docker stats --no-stream catalyst-app 2>/dev/null || echo "Контейнер не запущен"
  echo ""
fi

echo "🌐 API Health:"
if curl -s http://localhost:8080/api/health &> /dev/null; then
  curl -s http://localhost:8080/api/health | jq .
else
  echo "❌ API недоступен (localhost:8080)"
fi

echo ""
echo "📊 Статистика:"
if curl -s -H "X-API-Key: $DASHBOARD_API_KEY" http://localhost:8080/api/stats &> /dev/null; then
  curl -s -H "X-API-Key: $DASHBOARD_API_KEY" http://localhost:8080/api/stats | jq .
else
  echo "⚠️  Статистика недоступна (нужен API key)"
fi
