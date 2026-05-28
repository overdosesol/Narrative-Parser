# Catalyst

**Narrative & trend scanner with AI scoring and Telegram/Discord alerts.**

Catalyst continuously collects emerging topics from social sources, scores them
through a multi-stage AI pipeline, and pushes the high-signal ones to users via
a Telegram bot, a web dashboard, and (optionally) Discord. It's built to run as
a single Node.js process on one VPS — no microservices, no external queue, all
state in one SQLite file.

> Private operator repository. Not currently open-source; the sections below
> assume you already have access to the keys and infrastructure.

---

## What it does

- **Collects** trends from Reddit, Google Trends, X/Twitter and TikTok (source
  access depends on the user's plan).
- **Scores** each candidate through a staged pipeline (cheap dedup → pre-stage
  enrichment → clustering → Stage 1/2 LLM scoring) so only genuinely notable
  narratives surface.
- **Alerts** users in real time over Telegram (and Discord), with a web
  dashboard for browsing, filtering and manual on-demand analysis.
- **Bills** via Solana Pay across `free` / `test` / `pro` plans, with an
  admin panel for operations.

## How it works

```
collect → cheapDedup → PreStage → Cluster → Stage 1 → Stage 2 → Save → Alerts
```

Each stage can use a different LLM provider (xAI Grok, OpenAI, Google Gemini,
OpenRouter for vision) — configured per stage in `.env`. The dashboard and
admin panel are inline-React single-page apps served straight from Node.

## Tech stack

- **Runtime:** Node.js 20+ (ESM, native `fetch`, top-level `await`)
- **Storage:** SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — single file, WAL mode
- **Bot:** [`node-telegram-bot-api`](https://github.com/yagop/node-telegram-bot-api) (long polling)
- **HTTP:** Node's built-in `http` server (no Express) + [`undici`](https://github.com/nodejs/undici) for outbound calls
- **Images/video:** [`sharp`](https://github.com/lovell/sharp) + `ffmpeg`
- **Config:** [`dotenv`](https://github.com/motdotla/dotenv)
- **Deploy:** Docker (node:20-alpine) on a single VPS behind nginx + TLS

## Quick start (development)

```bash
git clone <your-fork> catalyst
cd catalyst
npm install
cp .env.example .env
# fill in at least TELEGRAM_BOT_TOKEN + XAI_API_KEY (see Configuration below)
npm run dev          # node --watch src/index.js
```

In development (no `NODE_ENV=production`) the app logs warnings for missing keys
and keeps running. In production it **refuses to start** if any required key is
missing — silent degradation is worse than a loud failure.

### Useful scripts

| Command | What it does |
|---|---|
| `npm start` | Run the app (`node src/index.js`) |
| `npm run dev` | Run with `--watch` auto-reload |
| `npm run check:spa` | Validate the inline-React SPAs (dashboard + admin) for syntax traps |
| `npm run check` | Alias for `check:spa` (the pre-deploy gate) |

> **Heads-up:** `src/dashboard/server.js` and `src/admin/server.js` embed large
> inline-React SPAs inside template literals. A stray backtick in a comment or a
> bad escape sequence yields a blank screen. **Always run `npm run check:spa`
> after editing those two files** — the deploy scripts run it automatically.

## Configuration

All configuration is environment variables — see [`.env.example`](.env.example)
for the full annotated list. The minimum to boot:

```bash
NODE_ENV=production
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_BOT_USERNAME=<your_bot_username_no_at>
XAI_API_KEY=<from x.ai>
ADMIN_API_KEY=<openssl rand -base64 32>
DASHBOARD_API_KEY=<openssl rand -base64 32>
DB_PATH=/var/lib/catalyst/data/catalyst.db
```

Apify (X/TikTok), OpenAI, Gemini, OpenRouter and Helius keys are optional and
unlock additional sources / providers when present.

## Plans

| Plan | Price | Duration | Sources | Manual analysis | Forecast |
|---|---|---|---|---|---|
| `free` | $0 | forever | Reddit + Google Trends | — | — |
| `test` | $5 | 1 day (one-time) | all 5 | 5/day | 5/day |
| `pro` | $100 | 30 days | all 5 | 100/day | 100/day |
| `admin` | $0 | forever | all 5 | unlimited | unlimited |

Plan rights are defined in one place: `src/billing/entitlements.js`.

## Project layout

```
src/
  index.js          # entry point — wires everything, schedulers, graceful shutdown
  collectors/       # source scrapers (Reddit, X, TikTok, Google Trends)
  analysis/         # pipeline stages, clustering, manual analysis
  scoring/          # Stage 1/2 LLM scoring + alert gate
  billing/          # plans / entitlements / Solana Pay
  notifications/    # Telegram + Discord delivery
  dashboard/        # public web UI (inline-React SPA + REST + SSE)
  admin/            # admin panel (inline-React SPA, loopback-only)
  db/               # SQLite schema + migrations + data access
  utils/            # logger, rate limiter, shared helpers
```

## Deployment

Production deployment is documented in **[DEPLOY.md](DEPLOY.md)** — VPS setup,
nginx + TLS, systemd/Docker, backups, restore, disaster recovery, secret
rotation and troubleshooting.

Deploys are done **only** through `deploy.ps1` (Windows) or `deploy.sh` (Linux)
— never edit the production host by hand.

## Operating context

Architecture state lives in `ai-context/SESSION_CONTEXT.md`; the running change
journal is `ai-context/WORKLOG.md`. Agent working rules are in
`ai-context/AGENT_RULES.md`.

## License

Proprietary / all rights reserved. Private repository — not licensed for
redistribution.
