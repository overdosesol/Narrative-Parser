# Catalyst v3.0 - Production Dockerfile
# Multi-stage build для оптимизации размера образа

# ─── Stage 1: Builder ───────────────────────────────────────────────────────

FROM node:20-alpine AS builder

WORKDIR /build

# Установить зависимости для компиляции
RUN apk add --no-cache python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev

# Скопировать package files
COPY package*.json ./

# Установить зависимости (включая optional для better-sqlite3)
RUN npm ci --only=production && \
    npm rebuild better-sqlite3

# ─── Stage 2: Runtime ──────────────────────────────────────────────────────

FROM node:20-alpine

LABEL maintainer="Catalyst Team <dev@catalyst.io>"
LABEL version="3.0"
LABEL description="24/7 AI-powered trend monitoring for memecoin narratives"

WORKDIR /app

# Установить runtime зависимости
RUN apk add --no-cache \
    sqlite-dev \
    curl \
    ca-certificates \
    ffmpeg \
    tini \
    git

# Установить Grok Build CLI (pinned version, binary в /root/.grok/bin/grok).
# BEST-EFFORT: если x.ai недоступен в момент сборки — образ всё равно собирается,
# а grokcli-провайдер просто будет недоступен (скоринг падает на API-fallback,
# фича ships OFF). Это сознательно: install НЕ должен ронять deploy-сборку и
# гасить прод из-за внешней зависимости от x.ai (ср. инцидент 502 «деплой всё разом»).
ARG GROK_CLI_VERSION=0.2.14
RUN (curl -fsSL https://x.ai/cli/install.sh | bash -s "${GROK_CLI_VERSION}" \
      && cp -L /root/.grok/bin/grok /usr/local/bin/grok \
      && chmod 755 /usr/local/bin/grok \
      && /usr/local/bin/grok --version) \
    || echo "WARN: Grok CLI install failed (x.ai unreachable?) — grokcli provider will be unavailable; scoring falls back to API."

# node:20-alpine already has user 'node' (uid/gid 1000) - use it directly

# Скопировать node_modules из builder
COPY --from=builder /build/node_modules ./node_modules

# Скопировать исходный код
COPY --chown=node:node . .

# Создать директории для данных и логов
RUN mkdir -p /data /logs /app/logs && \
    chown -R node:node /data /logs /app/logs /app

# Switch to non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:7357/api/health || exit 1

# Переменные окружения по умолчанию
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024" \
    DB_PATH=/data/catalyst.db \
    LOG_FILE=/logs/catalyst.log \
    DASHBOARD_PORT=8080 \
    ADMIN_PORT=8081 \
    DASHBOARD_HOST=0.0.0.0

# Использовать tini для правильной обработки сигналов
ENTRYPOINT ["/sbin/tini", "--"]

# Запустить приложение
CMD ["node", "src/index.js"]

# Expose ports
EXPOSE 8080 8081

# Volume points
VOLUME ["/data", "/logs"]
