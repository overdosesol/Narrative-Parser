# Catalyst

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](package.json)
[![Security policy](https://img.shields.io/badge/security-policy-blue)](SECURITY.md)
[![Open source ready](https://img.shields.io/badge/status-public%20OSS%20preview-6f42c1)](docs/open-source-readiness.md)

**Catalyst is an open-source AI trend intelligence system for catching fast
moving social narratives before they become obvious.**

It continuously collects candidates from Reddit, Google Trends, X/Twitter and
TikTok, deduplicates and clusters them, scores them with a multi-stage AI
pipeline, and sends high-signal alerts through Telegram and the web dashboard.

The project started as a single-operator production tool for memecoin and
internet-culture monitoring. It is now being opened as a practical reference
implementation for:

- building a cost-aware LLM scoring pipeline around noisy social data;
- running a full product from one Node.js process and one SQLite database;
- operating Telegram alerts, dashboard auth, billing gates and admin controls
  without a microservice stack;
- using OpenAI API models and Codex as part of real maintainer workflows.

> Current status: public OSS preview. The app runs in production for the
> maintainer, but setup still assumes an experienced operator with their own
> API keys, Telegram bots, Solana wallet, domain and VPS.

## What It Does

- **Collects trend signals** from Reddit, Google Trends, X/Twitter and TikTok.
- **Deduplicates noisy posts** before spending LLM budget.
- **Clusters related narratives** with embeddings, entity matching, image hash
  signals and source-aware heuristics.
- **Scores virality and meme potential** through configurable AI providers.
- **Sends alerts** to Telegram when a narrative clears the alert gate.
- **Provides a dashboard** for browsing, filtering, favorites, manual analysis
  and live updates.
- **Provides an admin panel** for source settings, plans, AI provider selection,
  prompt calibration and operational controls.
- **Supports paid access** through Solana Pay plans, with free/test/pro/admin
  entitlements.

## Pipeline

```text
collect -> cheapDedup -> PreStage -> Cluster -> Stage 1 -> Stage 2 -> Save -> Alerts
```

The core idea is to spend model calls only after cheaper checks have removed
obvious duplicates and junk.

| Stage | Purpose |
| --- | --- |
| `collect` | Pull candidates from configured sources. |
| `cheapDedup` | Remove exact or near-obvious duplicates without API calls. |
| `PreStage` | Optional text/video enrichment before clustering. |
| `Cluster` | Group related posts into one narrative candidate. |
| `Stage 1` | Base LLM scoring: virality, meme potential, alert type, explanation. |
| `Stage 2` | Deeper narrative verification for top candidates. |
| `Save` | Persist scored and save-only trends to SQLite. |
| `Alerts` | Apply per-user gates and deliver notifications. |

## OpenAI, GPT Models And Codex

Catalyst is built around interchangeable AI providers, but OpenAI is a first
class path in the codebase:

- **Stage 1 scoring** can run on OpenAI GPT models through the Responses API.
- **Embeddings** use OpenAI-compatible embedding endpoints for semantic
  clustering.
- **Stage 0a enrichment** can use a small GPT model for optional text
  normalization before clustering.
- **Maintainer workflow** uses Codex for codebase understanding, security
  review, documentation cleanup and release preparation.

This repository is also being prepared for the
[Codex for Open Source](https://developers.openai.com/community/codex-for-oss)
program. If accepted, API credits would be used for core open-source work:
review assistance, issue triage, security hardening, release notes, prompt
evaluation and regression checks for the AI scoring pipeline.

AI-generated changes are treated as drafts. The maintainer remains responsible
for review, testing, security decisions and releases.

## Architecture

Catalyst intentionally keeps the production shape small:

- **Runtime:** Node.js 20+ with ESM.
- **Storage:** SQLite via `better-sqlite3`, single database file, WAL mode.
- **HTTP:** Node's built-in `http` server, no Express dependency.
- **Bot:** `node-telegram-bot-api` with long polling.
- **Media:** `sharp` and `ffmpeg` for image/video handling.
- **Deploy:** Docker on one VPS behind nginx and TLS.

```text
src/
  index.js          app entry, scheduler, graceful shutdown
  collectors/       Reddit, X/Twitter, TikTok, Google Trends collectors
  analysis/         enrichment, clustering, URL/manual analysis, prompts
  scoring/          alert gate and scoring metadata helpers
  billing/          plans, entitlements, Solana Pay integration
  notifications/    Telegram delivery and alert dispatch
  dashboard/        public dashboard SPA, REST API and SSE
  admin/            loopback-only admin SPA and API
  db/               SQLite schema, migrations and data access
  utils/            logging, rate limiting and shared helpers
```

Two files deserve extra care:

- `src/dashboard/server.js`
- `src/admin/server.js`

Both embed large React single-page apps inside JavaScript template literals.
After editing either file, run `npm run check:spa`.

## Quick Start

```powershell
git clone https://github.com/overdosesol/Catalyst.git
Set-Location "Catalyst"
npm install
Copy-Item ".env.example" ".env"
npm run dev
```

Then fill `.env` with your own development keys. The app can run with limited
functionality while some optional providers are missing, but production mode
requires the critical keys described below.

## Configuration

All configuration is environment-based. Start with [`.env.example`](.env.example).

Minimum production keys:

```text
NODE_ENV=production
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
ADMIN_API_KEY=...
DASHBOARD_API_KEY=...
XAI_API_KEY=... or OPENAI_API_KEY=...
DB_PATH=/var/lib/catalyst/data/catalyst.db
```

Optional integrations unlock additional functionality:

| Integration | Used for |
| --- | --- |
| OpenAI | GPT scoring, embeddings, optional nano enrichment. |
| xAI | Grok scoring and deeper trend research paths. |
| Google AI / Gemini | media captioning and optional Stage 1 provider. |
| OpenRouter | fallback vision provider. |
| Apify | X/Twitter and TikTok data collection. |
| Helius / Solana RPC | Solana Pay verification. |

Never commit real `.env` files. The repository includes `.env.example` only.

## Useful Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the app with `node src/index.js`. |
| `npm run dev` | Run with Node watch mode for local development. |
| `npm run check:spa` | Validate embedded dashboard/admin React apps. |
| `npm run check` | Current pre-deploy check alias. |
| `npm test` | Run focused unit tests under `test/*.test.mjs`. |

## Deployment

Production deployment is documented in [DEPLOY.md](DEPLOY.md). The supported
path is Docker on a VPS behind nginx:

```powershell
.\deploy.ps1 -Server root@example.com
```

The deploy script validates the embedded SPAs, uploads a release archive,
syncs the operator's local `.env`, and runs the remote setup/update flow.

## Contributing

Contributions are welcome, especially around reliability, documentation,
security hardening, provider adapters, tests and operating guides.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Larger changes should begin as an
issue so we can agree on the behavior and avoid wasting your time.

Good first areas:

- documentation and setup improvements;
- tests around provider fallback behavior;
- safer billing/payment verification flows;
- small dashboard/admin fixes with `npm run check:spa`;
- security hardening that keeps the single-operator deployment model simple.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the current public roadmap and deferred
security/operational items.

## Security

Please do not report vulnerabilities in public issues. See
[SECURITY.md](SECURITY.md) for the private reporting flow and current security
notes.

## License

Catalyst is released under the [MIT License](LICENSE).
