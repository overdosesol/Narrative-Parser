# Catalyst — Deployment Guide

Production deployment runbook for the Catalyst narrative scanner (Telegram
bot + web dashboard + admin panel). Targeted at a single-VPS setup with
nginx + systemd. Adjust container details to taste.

---

## 1. Prerequisites

On the host:

- Node.js **20.x or newer** (uses native `fetch`, top-level `await`, ESM)
- `ffmpeg` (for the Reddit video proxy — optional but recommended)
- `sqlite3` cli (optional — for ad-hoc queries on the DB)
- A reverse proxy with TLS (nginx, Caddy, or Cloudflare Tunnel)
- A domain pointing to the host (e.g. `catalyst.example.com`)

External services you'll need accounts/keys for:

| Service | Required | What for |
|---------|----------|----------|
| Telegram BotFather | **yes** | Main bot + optional support bot |
| xAI (Grok) | **yes** | Stage 1/2 AI scoring |
| OpenAI | yes (or shared with xAI) | gpt-5.4-mini for Stage 1 batches, embeddings, nano enrichment |
| Apify | only if you want Twitter/X or TikTok | Tweet scraper, trends scraper |
| Helius | optional | Faster Solana RPC for payment confirmation |
| Google AI Studio + OpenRouter | optional | Vision (Stage 0b) — images + video understanding |

---

## 2. First-time setup

```bash
git clone <your-fork> /opt/catalyst
cd /opt/catalyst
npm ci --production
mkdir -p /var/lib/catalyst/data /var/log/catalyst
cp .env.example .env
chmod 600 .env
```

Then edit `.env` and fill in at least:

```
NODE_ENV=production
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_BOT_USERNAME=<your_bot_username_no_at>
XAI_API_KEY=<from x.ai>
ADMIN_API_KEY=<openssl rand -base64 32>
DASHBOARD_API_KEY=<openssl rand -base64 32>
PUBLIC_BASE_URL=https://catalyst.example.com
DASHBOARD_ALLOWED_ORIGINS=https://catalyst.example.com
DB_PATH=/var/lib/catalyst/data/catalyst.db
LOG_FILE=/var/log/catalyst/catalyst.log
```

**Critical:** with `NODE_ENV=production`, the app **refuses to start** if any
of `XAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ADMIN_API_KEY` is missing. This is
intentional — silent degradation in production is worse than a loud failure.
For dev work just unset `NODE_ENV` and you'll get warnings instead.

---

## 3. Run as a systemd service

Create `/etc/systemd/system/catalyst.service`:

```ini
[Unit]
Description=Catalyst narrative scanner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=catalyst
Group=catalyst
WorkingDirectory=/opt/catalyst
EnvironmentFile=/opt/catalyst/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
# Graceful-shutdown hard cap is 15s in code; give systemd 20s to be safe.
TimeoutStopSec=20
# Logs go to journald
StandardOutput=journal
StandardError=journal
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/catalyst /var/log/catalyst

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo useradd -r -s /bin/false catalyst
sudo chown -R catalyst:catalyst /opt/catalyst /var/lib/catalyst /var/log/catalyst
sudo systemctl daemon-reload
sudo systemctl enable --now catalyst
sudo journalctl -u catalyst -f
```

---

## 4. Reverse proxy (nginx)

Two ports to proxy:

- **`:7357`** — public dashboard (web UI + REST API + SSE)
- **`:8080`** — admin panel — **MUST be firewalled / never exposed publicly**

Example `/etc/nginx/sites-available/catalyst`:

```nginx
server {
    listen 443 ssl http2;
    server_name catalyst.example.com;

    # TLS — managed by certbot or your CDN
    ssl_certificate     /etc/letsencrypt/live/catalyst.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/catalyst.example.com/privkey.pem;

    # Body size for /api/manual-analysis (URL is small but be safe)
    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:7357;
        proxy_http_version 1.1;

        # SSE support — see /api/stream endpoint
        proxy_buffering off;
        proxy_read_timeout 24h;

        # Standard proxy headers
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Pass through Authorization for Bearer tokens
        proxy_set_header Authorization $http_authorization;
    }
}

# Force HTTPS
server {
    listen 80;
    server_name catalyst.example.com;
    return 301 https://$host$request_uri;
}
```

Reload: `sudo nginx -t && sudo systemctl reload nginx`.

### Admin port — DO NOT expose

Default `ADMIN_HOST=127.0.0.1` in `.env.example` keeps admin bound to
loopback. If you want remote access:

- **Option A (recommended):** SSH tunnel — `ssh -L 8080:127.0.0.1:8080 catalyst-host`
- **Option B:** Separate auth-walled subdomain — `admin.catalyst.example.com` with **basic auth** in nginx in front of the `X-Admin-Key` header. Don't rely on the admin key alone if you expose the port to the internet.

---

## 5. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 443/tcp    # HTTPS
sudo ufw allow 80/tcp     # HTTP (for cert renewal + redirect)
# DO NOT open 7357, 8080 — they're loopback-bound or proxied via nginx
sudo ufw enable
```

---

## 6. Backups

The entire app state is in **one SQLite file** at `DB_PATH`. Daily backup
via cron:

```bash
# /etc/cron.daily/catalyst-backup
#!/bin/bash
set -e
DEST=/var/backups/catalyst
mkdir -p "$DEST"
DATE=$(date +%Y%m%d-%H%M%S)
sqlite3 /var/lib/catalyst/data/catalyst.db ".backup $DEST/catalyst-$DATE.db"
# Keep 14 days
find "$DEST" -name 'catalyst-*.db' -mtime +14 -delete
```

`make executable`: `sudo chmod +x /etc/cron.daily/catalyst-backup`.

For off-host backups, push the dump to S3/Backblaze/your-NAS via rsync or
`aws s3 cp`. Avoid copying the file directly while the bot is running —
SQLite WAL mode tolerates it but `sqlite3 ".backup"` is safer.

---

## 7. Updates / rolling deploys

```bash
cd /opt/catalyst
git pull
npm ci --production
sudo systemctl restart catalyst
```

The systemd-level restart sends `SIGTERM` to the process. The graceful
shutdown handler (`src/index.js`):

1. Stops collectors / new alerts
2. Drains active HTTP requests up to 10s
3. Closes SSE streams cleanly (browsers see `event: bye` and reconnect)
4. Closes the DB
5. Exits within 15s hard-cap

In-flight users see no errors as long as their request completes within 10s.
Long-running requests (manual `/analyze`) get cut off — that's fine, they're
re-runnable from the UI.

---

## 8. Health checks

For an external uptime monitor (UptimeRobot, BetterStack, etc.):

```
GET https://catalyst.example.com/api/health
```

Returns `{ ok: true, uptime: <seconds>, paused: <bool> }`. Public, no auth.

For the admin port (only reachable from localhost / SSH tunnel):

```
GET http://127.0.0.1:8080/api/health
```

---

## 9. Telegram bot mode — polling (current) vs webhook

The bot currently uses **long polling** (Telegram Bot API). Works on a
single process behind any kind of NAT/firewall — no inbound port needed
for Telegram.

If/when you scale to multiple processes or want lower alert latency, switch
to **webhook mode**:

```bash
# In .env (NOT YET WIRED — placeholder for future migration)
TELEGRAM_WEBHOOK_URL=https://catalyst.example.com/tg-webhook
```

Migration is non-trivial (requires registering the webhook with Telegram,
adding a webhook handler route, dropping `polling: true` in the bot init).
Not blocking for launch — single-process polling handles ~thousands of
users without issue.

---

## 10. Common operational tasks

| Task | How |
|------|-----|
| Tail live logs | `sudo journalctl -u catalyst -f` |
| Last 1h of errors only | `sudo journalctl -u catalyst --since '1 hour ago' -p err` |
| Query DB | `sqlite3 /var/lib/catalyst/data/catalyst.db` |
| Force pause all alerts | Admin panel → top right → pause toggle |
| Disable a collector | Dashboard (admin user only) → /sources page → toggle |
| Reset a stuck user | Admin panel → /users → search → reset state |
| Hot refresh on demand | Admin panel → "Hot trends refresh" → "Run now" |
| Rotate ADMIN_API_KEY | Edit `.env`, `systemctl restart catalyst`, update operator's key store |
| Backup right now | `sudo /etc/cron.daily/catalyst-backup` |

---

## 11. Pre-launch checklist

Before flipping the DNS / sharing the link publicly:

- [ ] `NODE_ENV=production` in `.env`
- [ ] All required env vars filled (`systemctl restart catalyst` succeeds)
- [ ] `PUBLIC_BASE_URL` set
- [ ] `DASHBOARD_ALLOWED_ORIGINS` set to your domain
- [ ] `ADMIN_HOST=127.0.0.1` (default — verify)
- [ ] `ADMIN_API_KEY` is a strong 32+ char random string
- [ ] Firewall lets only 22/80/443 in
- [ ] TLS cert valid, HSTS works (`curl -I https://...`)
- [ ] Daily backup cron tested manually once
- [ ] You can reach the bot via `https://t.me/<your_bot_username>` and `/start` works
- [ ] Login flow: dashboard → "Sign in via Telegram" → bot deep-link → 6-digit code → dashboard works
- [ ] Test payment flow with **$5 plan + small SOL/USDC test** before opening to public
- [ ] `journalctl` shows no warnings/errors from startup

---

## 12. Post-launch monitoring

What to watch for the first week:

- **Memory growth** — Node SQLite + caches; should stabilize under 300MB.
  If it climbs steadily, suspect a Map leak (e.g. `_manualAnalysisHits`
  not pruning). Restart fixes it temporarily.
- **DB size** — `du -h /var/lib/catalyst/data/catalyst.db`. Old trends are
  pruned daily (30-day retention by default), but feedback rows accumulate.
- **Failed alerts** — `journalctl -u catalyst | grep "Alert send failed"`.
  Most are users who blocked the bot; we auto-suspend them.
- **Auth flood** — `journalctl -u catalyst | grep "Too many"` reveals
  rate-limit hits. If a real user is locked out, they `/start` again and
  the cooldown forgets after 15 min.

---

## 13. Future hardening (not blocking for v1)

- **Telegram webhook** — drops alert latency from 3-5s polling to ~instant
- **Redis** for `_authVerifyAttempts`, `_authInitiateAttempts`,
  `_manualAnalysisHits` — if/when running multiple processes
- **Content-Security-Policy** header — currently relaxed because the SPA
  inlines its own React + styles into the HTML. Tightening requires
  splitting CSS/JS into separate files.
- **CI build** — GitHub Actions or similar, running `npm test` (when tests
  are added) + `npm audit` on PR
- **Log rotation** — currently relies on journald's default rotation.
  Consider `logrotate` if logs get noisy.

That's it. Everything else is in `ai-context/SESSION_CONTEXT.md` for the
deeper architecture context.
