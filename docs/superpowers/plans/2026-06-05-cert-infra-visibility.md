# Cert + Infra Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- []`) syntax for tracking.

**Goal:** Close PROD-007 + PROD-008 + PROD-021 + DOC-003 + DOC-004 (+ bonus port drift): commit prod nginx config to repo, add cert expiry monitor script, document cert renewal + secret rotation SOPs.

**Architecture:** Minimal-invasion docs-heavy bundle. One new nginx config file (exact prod copy), one new bash script (cert expiry check), three DEPLOY.md sections (port fix + cert SOP + secret rotation), one SESSION_CONTEXT update. No app code changes.

**Tech Stack:** Bash, openssl s_client, certbot (already on prod), cron, markdown docs.

**Spec reference:** `docs/superpowers/specs/2026-06-05-cert-infra-visibility-design.md`

---

## File Structure

### Files created
- `scripts/nginx-catalyst.conf` — production nginx config, source of truth, manually scp'd to VPS on changes
- `scripts/check-cert-expiry.sh` — bash, daily cron, warn if < 14 days

### Files modified
- `DEPLOY.md` — port drift fix (4 places) + §4.2 TLS cert renewal SOP + §10.1 Secret rotation SOP
- `ai-context/SESSION_CONTEXT.md` — Production posture: 3 new bullets (nginx in repo, cert monitor, secret rotation)
- `ai-context/WORKLOG.md` — Bundle #17 entry (added by operator in T7)

### Files NOT touched
- Real prod nginx config — operator scp's `scripts/nginx-catalyst.conf` to `/etc/nginx/sites-available/catalyst` manually (out of subagent scope, T7 operator task)
- Real prod cron — operator installs cert-check script + cron entry manually (T7)
- `src/server.js`, `src/admin/server.js` — not modified
- `package.json`, `deploy.{ps1,sh}` — not modified (out of scope per spec)

---

## Task Order Rationale

1. **T1 (nginx config)** — concrete artifact, baseline for later docs that reference it
2. **T2 (check-cert script)** — concrete artifact, baseline for §4.2 docs
3. **T3 (port drift fix)** — small atomic fix, can land before larger §4.2 / §10.1
4. **T4 (§4.2 cert SOP)** — references T2 script + nginx
5. **T5 (§10.1 secret rotation)** — independent doc
6. **T6 (SESSION_CONTEXT update)** — references all of the above
7. **T7 (operator deploy to VPS + WORKLOG)** — final acceptance gate

T1-T6 are subagent-driven file work. T7 requires SSH + cron edits on VPS.

---

## Task 1: Create `scripts/nginx-catalyst.conf`

**Files:**
- Create: `scripts/nginx-catalyst.conf`

- [ ] **Step 1: Write the file**

Create `scripts/nginx-catalyst.conf` with this exact content:

```nginx
# catalystparser.io — public dashboard, proxied to Docker container on :8080
# TLS managed by certbot (Let's Encrypt).
#
# Source of truth: scripts/nginx-catalyst.conf in repo (Bundle #17, 2026-06-05).
# On change in repo: scp this file to /etc/nginx/sites-available/catalyst on VPS,
# then: sudo nginx -t && sudo systemctl reload nginx
# Do NOT edit /etc/nginx/sites-available/catalyst on the VPS directly — drift unrecoverable.

server {
    server_name catalystparser.io www.catalystparser.io;

    # Body size cap for /api/manual-analysis
    client_max_body_size 64k;

    # Real-IP for downstream rate-limiter (TRUST_PROXY=1 in app)
    set_real_ip_from 127.0.0.1;
    real_ip_header X-Forwarded-For;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # SSE support (/api/stream — long-lived event stream)
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

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/catalystparser.io/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/catalystparser.io/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}


server {
    if ($host = www.catalystparser.io) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    if ($host = catalystparser.io) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    listen [::]:80;
    server_name catalystparser.io www.catalystparser.io;
    return 404; # managed by Certbot
}
```

- [ ] **Step 2: Verify content**

```bash
grep -c "server_name catalystparser.io" scripts/nginx-catalyst.conf
```

Expected: `2` (one in each server block).

```bash
grep -c "proxy_pass http://127.0.0.1:8080" scripts/nginx-catalyst.conf
```

Expected: `1`.

```bash
grep -c "managed by Certbot" scripts/nginx-catalyst.conf
```

Expected: `8` (cert paths + redirects + 404 + ssl listen lines).

- [ ] **Step 3: Verify only this file is new in this task**

```bash
git status --short scripts/nginx-catalyst.conf
```

Expected: `?? scripts/nginx-catalyst.conf` (untracked, new).

- [ ] **Step 4: NO COMMIT.**

---

## Task 2: Create `scripts/check-cert-expiry.sh`

**Files:**
- Create: `scripts/check-cert-expiry.sh`

- [ ] **Step 1: Write the file**

Create `scripts/check-cert-expiry.sh` with this exact content:

```bash
#!/bin/bash
# Catalyst HTTPS certificate expiry check
# Source of truth: scripts/check-cert-expiry.sh in repo (Bundle #17, 2026-06-05).
# On VPS install (manual, per DEPLOY.md §4.2):
#   scp scripts/check-cert-expiry.sh root@vps:/usr/local/bin/
#   ssh root@vps "chmod +x /usr/local/bin/check-cert-expiry.sh"
#   ssh root@vps "echo '#!/bin/bash' > /etc/cron.daily/catalyst-cert-check"
#   ssh root@vps "echo '/usr/local/bin/check-cert-expiry.sh catalystparser.io' >> /etc/cron.daily/catalyst-cert-check"
#   ssh root@vps "chmod +x /etc/cron.daily/catalyst-cert-check"

set -euo pipefail

DOMAIN="${1:-catalystparser.io}"
WARN_DAYS=14   # exit 1 if cert expires in less than WARN_DAYS
LOG_FILE="${LOG_FILE:-/var/log/catalyst-cert.log}"

# Fetch cert expiry date (external check — works from any host that can reach domain)
EXPIRY_RAW=$(echo | openssl s_client -connect "$DOMAIN":443 -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null \
  | sed 's/notAfter=//')

if [ -z "$EXPIRY_RAW" ]; then
  echo "$(date -Is) FATAL: could not fetch cert expiry for $DOMAIN" | tee -a "$LOG_FILE" >&2
  exit 2
fi

EXPIRY_TS=$(date -d "$EXPIRY_RAW" +%s)
NOW_TS=$(date +%s)
DAYS_LEFT=$(( (EXPIRY_TS - NOW_TS) / 86400 ))

if [ "$DAYS_LEFT" -lt "$WARN_DAYS" ]; then
  echo "$(date -Is) WARNING: $DOMAIN cert expires in $DAYS_LEFT days ($EXPIRY_RAW)" | tee -a "$LOG_FILE" >&2
  exit 1
fi

echo "$(date -Is) OK: $DOMAIN cert valid for $DAYS_LEFT days (expires $EXPIRY_RAW)" | tee -a "$LOG_FILE"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/check-cert-expiry.sh
```

On Windows file system chmod may have no effect. Use git's executable bit:

```bash
git update-index --add --chmod=+x scripts/check-cert-expiry.sh
```

Verify:
```bash
git ls-files -s scripts/check-cert-expiry.sh
```

Expected: `100755 ... scripts/check-cert-expiry.sh` (mode 100755 = executable).

- [ ] **Step 3: Bash syntax check**

```bash
bash -n scripts/check-cert-expiry.sh
```

Expected: exit 0, no output.

- [ ] **Step 4: Optional local test** (if openssl is available on dev machine)

```bash
bash scripts/check-cert-expiry.sh catalystparser.io
```

Expected: exit 0 with message like `OK: catalystparser.io cert valid for NN days (expires <date>)`.

If openssl isn't on dev machine — skip this step, operator will test on VPS in T7.

- [ ] **Step 5: NO COMMIT.**

---

## Task 3: Fix DEPLOY.md §4 port drift (4 places)

**Files:**
- Modify: `DEPLOY.md` (4 targeted edits)

- [ ] **Step 1: Read current §4 to confirm anchors**

```bash
sed -n '111,170p' DEPLOY.md
```

Expected: shows §4 nginx config example with mentions of port 7357 (dashboard) and 8080 (admin). These are the OLD ports. Real prod = dashboard 8080, admin 8081.

- [ ] **Step 2: Fix dashboard port description (line ~115-116)**

Edit:
- `old_string`: `- **\`:7357\`** — public dashboard (web UI + REST API + SSE)`
- `new_string`: `- **\`:8080\`** — public dashboard (web UI + REST API + SSE)`

- [ ] **Step 3: Fix admin port description (line ~117)**

Edit:
- `old_string`: `- **\`:8080\`** — admin panel — **MUST be firewalled / never exposed publicly**`
- `new_string`: `- **\`:8081\`** — admin panel — **MUST be firewalled / never exposed publicly**`

- [ ] **Step 4: Fix proxy_pass in nginx example (line ~133)**

Edit:
- `old_string`: `        proxy_pass http://127.0.0.1:7357;`
- `new_string`: `        proxy_pass http://127.0.0.1:8080;`

- [ ] **Step 5: Fix admin SSH tunnel example (line ~166)**

Edit:
- `old_string`: `- **Option A (recommended):** SSH tunnel — \`ssh -L 8080:127.0.0.1:8080 catalyst-host\``
- `new_string`: `- **Option A (recommended):** SSH tunnel — \`ssh -L 8081:127.0.0.1:8081 catalyst-host\``

- [ ] **Step 6: Verify no `:7357` references remain**

```bash
grep -n "7357" DEPLOY.md
```

Expected: no output (no matches). If anything remains — that line was missed.

```bash
grep -nE ":8080|:8081" DEPLOY.md
```

Expected: shows the new dashboard `:8080` references + the new admin `:8081` references. Sanity-check that admin tunnel uses 8081 and dashboard proxy uses 8080.

- [ ] **Step 7: NO COMMIT.**

---

## Task 4: Add DEPLOY.md §4.2 TLS certificate renewal verification

**Files:**
- Modify: `DEPLOY.md` (insert §4.2 between §4.1 Admin port and §5 Firewall)

- [ ] **Step 1: Confirm §4.1 end location**

```bash
sed -n '161,172p' DEPLOY.md
```

Expected: shows `### Admin port — DO NOT expose` section content ending with a paragraph about Option A/B (around line 167-168), then `---` separator at line ~169-170, then `## 5. Firewall` at line 171.

The §4.2 insertion point is **after the §4.1 content (last line of its prose) and BEFORE the `---` separator**.

- [ ] **Step 2: Identify exact anchor**

The last line of §4.1 is the Option B line ending with `Don't rely on the admin key alone if you expose the port to the internet.`

Run:
```bash
grep -n "Don't rely on the admin key" DEPLOY.md
```

Expected: one match. Note line number.

- [ ] **Step 3: Insert §4.2 after §4.1**

Edit:
- `old_string`: `- **Option B:** Separate auth-walled subdomain — \`admin.catalyst.example.com\` with **basic auth** in nginx in front of the \`X-Admin-Key\` header. Don't rely on the admin key alone if you expose the port to the internet.`
- `new_string`: (the same line) + new section appended:

```
- **Option B:** Separate auth-walled subdomain — `admin.catalyst.example.com` with **basic auth** in nginx in front of the `X-Admin-Key` header. Don't rely on the admin key alone if you expose the port to the internet.

### 4.2. TLS certificate renewal verification

Certbot auto-renews HTTPS cert every ~60 days (cert valid 90 days, renews at 30 days remaining). **Renewal can fail silently** if port 80 is blocked, DNS misconfigured, or certbot.timer is disabled. Bundle #17 (2026-06-05) adds monitoring + SOP.

#### Daily auto-check

`scripts/check-cert-expiry.sh` runs daily via cron, logs to `/var/log/catalyst-cert.log`, exit 1 (warn) if cert expires in less than 14 days. Install on VPS (one-time setup):

```bash
scp scripts/check-cert-expiry.sh root@catalystparser.io:/usr/local/bin/
ssh root@catalystparser.io "chmod +x /usr/local/bin/check-cert-expiry.sh"
ssh root@catalystparser.io "echo '#!/bin/bash' > /etc/cron.daily/catalyst-cert-check"
ssh root@catalystparser.io "echo '/usr/local/bin/check-cert-expiry.sh catalystparser.io' >> /etc/cron.daily/catalyst-cert-check"
ssh root@catalystparser.io "chmod +x /etc/cron.daily/catalyst-cert-check"
```

If cron MAILTO is configured, operator gets email on warning. Otherwise check log weekly:

```bash
ssh root@catalystparser.io "tail -10 /var/log/catalyst-cert.log"
```

#### Manual verification

```bash
# 1. Certbot timer status (should be active, enabled)
sudo systemctl status certbot.timer

# 2. Last 20 renewal attempts (look for errors)
sudo journalctl -u certbot.timer -n 20

# 3. List all certs + expiry dates
sudo certbot certificates

# 4. External check (from any machine, no SSH needed)
echo | openssl s_client -connect catalystparser.io:443 2>/dev/null \
  | openssl x509 -noout -dates
# Expected: notAfter=<date 30-90d in future>

# 5. Manual renewal dry-run (safe — doesn't actually renew)
sudo certbot renew --dry-run
```

#### If renewal failed

1. Check `journalctl -u certbot.timer` for the error message
2. Verify port 80 accessible: `ufw status`, `curl -I http://catalystparser.io`
3. Manual renewal: `sudo certbot renew`
4. Reload nginx: `sudo nginx -t && sudo systemctl reload nginx`
5. Re-test cert: `echo | openssl s_client -connect catalystparser.io:443 | openssl x509 -noout -dates`
6. Log result in `ai-context/WORKLOG.md`: date, reason, fix applied

#### nginx config in repo

The production nginx config is versioned at `scripts/nginx-catalyst.conf`. On change in repo:

```bash
scp scripts/nginx-catalyst.conf root@catalystparser.io:/etc/nginx/sites-available/catalyst
ssh root@catalystparser.io "sudo nginx -t && sudo systemctl reload nginx"
```

**Do not edit `/etc/nginx/sites-available/catalyst` directly on VPS** — drift unrecoverable.
```

(End of inserted §4.2 block. Note: this includes the §4.1 Option B line at the start to give Edit a unique anchor. The blank line and `### 4.2.` heading start the new section. Final paragraph in §4.2 ends with "drift unrecoverable.")

- [ ] **Step 4: Verify insertion**

```bash
grep -n "^### 4\." DEPLOY.md
```

Expected:
```
161:### Admin port — DO NOT expose
NNN:### 4.2. TLS certificate renewal verification
```

Where NNN is the new line for §4.2.

```bash
grep -c "check-cert-expiry.sh" DEPLOY.md
```

Expected: 3 (script name appears in scp command + cron creation + comment about source of truth path).

- [ ] **Step 5: NO COMMIT.**

---

## Task 5: Add DEPLOY.md §10.1 Secret rotation

**Files:**
- Modify: `DEPLOY.md` (insert §10.1 inside §10, after the operations table)

- [ ] **Step 1: Confirm §10 table end + §11 start**

```bash
sed -n '437,455p' DEPLOY.md
```

Expected: shows `## 10. Common operational tasks` heading + table (ending with `Backup right now` row at line ~449), then `---` separator (~451), then `## 11.` (~453).

The §10.1 insertion point is **after the table end (line ~449) and BEFORE the `---` separator (~451)**.

- [ ] **Step 2: Find unique anchor**

Run:
```bash
grep -n "Backup right now" DEPLOY.md
```

Expected: one match. This is the LAST row of the §10 table.

- [ ] **Step 3: Insert §10.1**

Edit:
- `old_string`: `| Backup right now | \`sudo /etc/cron.daily/catalyst-backup\` |`
- `new_string`: (same line) + blank line + new section:

```
| Backup right now | `sudo /etc/cron.daily/catalyst-backup` |

### 10.1. Secret rotation

Each secret has a lifetime. Bundle #17 (2026-06-05) documents the recommended rotation schedule + per-key procedure + incident response if a key leaks.

#### Rotation schedule

| Key | Cadence | Where to rotate | Verification after |
|---|---|---|---|
| `XAI_API_KEY` | 90 days | https://x.ai/api/keys | Manual trend rescore → check log `stage1 ok` |
| `OPENAI_API_KEY` | 90 days | https://platform.openai.com/api-keys | Manual trend rescore → check stage1 batch logs |
| `GEMINI_API_KEY` | 90 days | https://aistudio.google.com | Manual trend with image → check stage0b log |
| `OPENROUTER_API_KEY` | 90 days | https://openrouter.ai/keys | Same as Gemini (Vision fallback) |
| `TELEGRAM_BOT_TOKEN` | only if leaked | @BotFather → `/revoke` (regenerates) | `/start` → bot responds |
| `SUPPORT_BOT_TOKEN` | 180 days | @BotFather | Same |
| `ADMIN_API_KEY` | 90 days or after operator change | local `openssl rand -base64 32` | `curl -H "X-Admin-Key: ..." /admin/api/health` |
| `DASHBOARD_API_KEY` | 180 days | local `openssl rand -base64 32` | Browser login still works |
| `HELIUS_API_KEY` | 180 days | https://helius.dev | Solana payment confirmation test |
| `APIFY_TWEET_SCRAPER_TOKEN` | 180 days | https://console.apify.com/account/integrations | Manual X collection → check log |
| `APIFY_TRENDS_SCRAPER_TOKEN` | 180 days | same | Manual trends collection |
| `TIKTOK_*` keys | 180 days | https://console.apify.com | Manual TikTok collection |

#### Per-key procedure

1. **Generate** new key on the provider side (keep old key active for now)
2. **Edit `.env`** on VPS: `ssh root@catalystparser.io "nano /opt/catalyst/.env"` — replace old value with new
3. **Restart**: `ssh root@catalystparser.io "cd /opt/catalyst && docker compose restart app"`
4. **Verify** using the test from the schedule table above
5. **Revoke old key** on the provider side (only AFTER verification — otherwise risk downtime if new key doesn't work)
6. **Log** in `ai-context/WORKLOG.md`:
   ```
   ## YYYY-MM-DD · rotation · <KEY_NAME> · OK · verified <method>
   ```

#### If leak suspected (incident response)

1. **Immediately**: revoke old key on the provider side (even before preparing the new one — better downtime than abuse)
2. Generate new key
3. Edit `.env`, restart container, verify
4. WORKLOG entry: date, key, reason (leak/suspected), source of leak if known
5. Audit: check provider usage logs for anomalies during leak window
```

(End of §10.1 insertion. Note: includes the original `Backup right now` table row as the unique anchor at the start.)

- [ ] **Step 4: Verify**

```bash
grep -n "^### 10\." DEPLOY.md
```

Expected: one match — `### 10.1. Secret rotation`.

```bash
grep -c "XAI_API_KEY\|TELEGRAM_BOT_TOKEN\|ADMIN_API_KEY" DEPLOY.md
```

Expected: ≥ 5 matches (these keys appear in the rotation table + procedure + possibly elsewhere in DEPLOY.md).

- [ ] **Step 5: NO COMMIT.**

---

## Task 6: Update `ai-context/SESSION_CONTEXT.md` Production posture

**Files:**
- Modify: `ai-context/SESSION_CONTEXT.md` (add 3 bullets near Deploy gate / Daily backup section)

- [ ] **Step 1: Find existing Deploy gate bullet (from Bundle #16)**

```bash
grep -n "Deploy gate" ai-context/SESSION_CONTEXT.md
```

Expected: one match. The Deploy gate bullet was added in Bundle #16 right after the Daily backup bullet. Bundle #17's three new bullets should land right after the Deploy gate bullet for logical grouping.

```bash
sed -n 'N,Mp' ai-context/SESSION_CONTEXT.md
```

(Where N and M bracket the Deploy gate bullet — read ~3 lines to find its END.)

- [ ] **Step 2: Insert 3 new bullets after Deploy gate**

The Deploy gate bullet ends with `... Bundle #16 (2026-06-04) закрыл QUAL-001 + PROD-002/003.`

Edit:
- `old_string`: the tail of the Deploy gate bullet — `... Bundle #16 (2026-06-04) закрыл QUAL-001 + PROD-002/003.`
- `new_string`: same tail + 3 new bullets:

```
... Bundle #16 (2026-06-04) закрыл QUAL-001 + PROD-002/003.
- **nginx config**: source of truth — `scripts/nginx-catalyst.conf` в репо. На изменении: scp → `/etc/nginx/sites-available/catalyst` на VPS + `sudo nginx -t && systemctl reload nginx`. Не правим вручную на сервере (drift unrecoverable). Прод-конфиг: `proxy_pass http://127.0.0.1:8080` (dashboard), admin на `:8081` localhost-only без nginx. Bundle #17 (2026-06-05).
- **Cert monitoring**: `/usr/local/bin/check-cert-expiry.sh` (source: `scripts/check-cert-expiry.sh`) запускается ежедневно через `/etc/cron.daily/catalyst-cert-check`. Warn в `/var/log/catalyst-cert.log` если < 14 дней до expiry. Externally проверяет via `openssl s_client`. Подробности: DEPLOY.md §4.2. Bundle #17.
- **Secret rotation**: schedule + per-key procedure — DEPLOY.md §10.1. 90д для AI keys (xAI/OpenAI/Gemini/OpenRouter) + ADMIN_API_KEY, 180д для Apify/Helius/DASHBOARD_API_KEY/SUPPORT_BOT_TOKEN, only-on-leak для TELEGRAM_BOT_TOKEN. Bundle #17.
```

(The `... Bundle #16 (2026-06-04) закрыл QUAL-001 + PROD-002/003.` opening is for Edit anchor — replace with the entire 4-bullet block starting with the same closing line.)

- [ ] **Step 3: Verify**

```bash
grep -nE "nginx config|Cert monitoring|Secret rotation" ai-context/SESSION_CONTEXT.md
```

Expected: 3 matches near the Deploy gate bullet, all referencing Bundle #17.

```bash
grep -c "Bundle #17" ai-context/SESSION_CONTEXT.md
```

Expected: at least 3.

- [ ] **Step 4: Check for any port drift in SESSION_CONTEXT.md**

```bash
grep -nE "7357|:8080|:8081" ai-context/SESSION_CONTEXT.md | head -10
```

If `7357` appears anywhere — that's stale (real prod dashboard = 8080). Note the line(s). If the references are in current-state descriptions, fix them with separate Edit calls:
- `old_string`: containing `7357` in context of dashboard port
- `new_string`: same with `8080`

If `7357` doesn't appear — good, SESSION_CONTEXT is clean. Skip the fix.

- [ ] **Step 5: NO COMMIT.**

---

## Task 7: Operator — VPS install + manual test + WORKLOG entry

**Files:**
- No code changes
- Add: WORKLOG entry to `ai-context/WORKLOG.md`

This task is operator-driven (requires SSH to VPS).

- [ ] **Step 1: Verify nginx config in repo matches prod**

```bash
ssh root@37.1.196.83 "cat /etc/nginx/sites-available/catalyst" > /tmp/prod-nginx.conf
diff /tmp/prod-nginx.conf scripts/nginx-catalyst.conf
```

Expected: only difference is the new top comment block we added (`# catalystparser.io — public dashboard...`). Everything else should match exactly.

If there's a substantive difference — prod config has drifted since the brainstorm SSH cat. Investigate before continuing.

- [ ] **Step 2: Install cert-expiry script on VPS**

```bash
scp scripts/check-cert-expiry.sh root@37.1.196.83:/usr/local/bin/
ssh root@37.1.196.83 "chmod +x /usr/local/bin/check-cert-expiry.sh"
```

Verify:
```bash
ssh root@37.1.196.83 "ls -l /usr/local/bin/check-cert-expiry.sh"
```

Expected: shows the file with executable bit (`-rwxr-xr-x`).

- [ ] **Step 3: Create cron entry**

```bash
ssh root@37.1.196.83 "cat > /etc/cron.daily/catalyst-cert-check << 'EOF'
#!/bin/bash
/usr/local/bin/check-cert-expiry.sh catalystparser.io
EOF"
ssh root@37.1.196.83 "chmod +x /etc/cron.daily/catalyst-cert-check"
```

Verify:
```bash
ssh root@37.1.196.83 "cat /etc/cron.daily/catalyst-cert-check && ls -l /etc/cron.daily/catalyst-cert-check"
```

Expected: shows the 2-line shell script + executable bit.

- [ ] **Step 4: Manual test**

```bash
ssh root@37.1.196.83 "/usr/local/bin/check-cert-expiry.sh catalystparser.io"
```

Expected: output like `2026-06-05T... OK: catalystparser.io cert valid for NN days (expires <date>)`. Exit code 0.

If exit code != 0:
- If exit 1 (warn): cert really is <14 days out — renew now via `sudo certbot renew`
- If exit 2 (fatal): could not fetch — check openssl is installed, domain resolvable, port 443 accessible

- [ ] **Step 5: Verify log file was written**

```bash
ssh root@37.1.196.83 "cat /var/log/catalyst-cert.log"
```

Expected: at least one line matching what step 4 output. If file doesn't exist — script couldn't write to `/var/log/` (permission issue). Adjust LOG_FILE or run as root.

- [ ] **Step 6: Add WORKLOG entry**

At the top of `ai-context/WORKLOG.md` (right after the `---` on line 12, BEFORE the existing top entry), insert this new entry. Replace `<DAYS>` and `<EXPIRY_DATE>` with the real values from step 4.

```markdown
## 2026-06-05 · sonnet · Bundle #17 — Cert + infra visibility

**Цель**: закрыть PROD-007 + PROD-008 + PROD-021 + DOC-003 + DOC-004 — версионировать prod nginx config в репо, добавить cert expiry monitor + cron, задокументировать cert renewal + secret rotation SOPs. Tier 1 #17 из `docs/audit/INDEX.md`.

**Контекст**: prod nginx config жил только на VPS (`/etc/nginx/sites-available/catalyst`), HTTPS мог тихо умереть на 90д (нет alerting'а), secret rotation был только 1-liner stub в DEPLOY.md. Operator принёс prod nginx через ssh cat — обнаружил drift в DEPLOY.md §4 (примерный port 7357 vs real 8080; admin tunnel 8080 vs real 8081). Закрыли заодно.

**Метод**: brainstorm (`docs/superpowers/specs/2026-06-05-cert-infra-visibility-design.md`) → 7-task plan (`docs/superpowers/plans/2026-06-05-cert-infra-visibility.md`), subagent-driven T1-T6, operator-driven T7. Operator выбрал «Минимум» scope (per Bundle #16 pattern — TG bot pings + auto-deploy nginx + external uptime monitor + DR section deferred).

**Файлы**:
- `scripts/nginx-catalyst.conf` (new) — exact copy of prod nginx config (`proxy_pass http://127.0.0.1:8080`, certbot-managed TLS, set_real_ip_from 127.0.0.1, 4 X-headers + Authorization passthrough)
- `scripts/check-cert-expiry.sh` (new) — bash + openssl, exit 1 if < 14 days, exit 2 if fetch fails, log в `/var/log/catalyst-cert.log`
- `DEPLOY.md` — port drift fix (4 places: §4 dashboard description, admin description, proxy_pass example, admin ssh tunnel example) + new §4.2 TLS certificate renewal verification (~70 lines: install script + manual verification + если упало + nginx config in repo note) + new §10.1 Secret rotation (~50 lines: 12-key schedule table + per-key procedure + incident response)
- `ai-context/SESSION_CONTEXT.md` — Production posture: 3 new bullets (nginx config, Cert monitoring, Secret rotation) after Deploy gate (Bundle #16)

**Deploy/verification**:
- `diff <(ssh ... cat /etc/nginx/sites-available/catalyst) scripts/nginx-catalyst.conf` → only header comment difference
- `scp scripts/check-cert-expiry.sh root@vps:/usr/local/bin/` + chmod +x → done
- `/etc/cron.daily/catalyst-cert-check` создан, chmod +x → done
- Manual test: `ssh root@vps "/usr/local/bin/check-cert-expiry.sh catalystparser.io"` → `OK: catalystparser.io cert valid for <DAYS> days (expires <EXPIRY_DATE>)`, exit 0
- `/var/log/catalyst-cert.log` записан

**Closed findings (audit series)**:
- PROD-007 (nginx config теперь в репо как `scripts/nginx-catalyst.conf`, manual sync задокументирован)
- PROD-008 (daily cert expiry check via cron, warn если < 14д)
- PROD-021 (secret rotation полностью задокументирован: schedule + per-key procedure + incident response)
- DOC-003 (DEPLOY.md §4.2 full cert renewal verification SOP)
- DOC-004 (DEPLOY.md §10.1 full secret rotation SOP)

**Bonus** (discovered during brainstorm, not in audit):
- DEPLOY.md §4 port drift: dashboard 7357 → 8080, admin 8080 → 8081, proxy_pass example, ssh tunnel example. 4 fix'а.

**Не закрыто (deferred)**:
- TG bot pings при cert expiry — Bundle #15 (Bot resilience) territory
- Auto-deploy nginx config через `deploy.{ps1,sh}` — требует `sudo nginx -t && systemctl reload nginx` логику; defer как риск сломать prod
- External uptime monitor (UptimeRobot/BetterStack) — operator может настроить отдельно
- DR section в DEPLOY.md (VPS погиб целиком) — большой scope, отдельный bundle

**Tier 1 progress**: Bundle #1 + #16 + #17 closed. Tier 1 fully done. Tier 2 next: #2 Observability persistence migration / #3 URL safety bundle / #11 A11y compliance sprint / #13 Standardized error visibility / #19 Dead code cleanup pass.

**Риски/заметки**:
- `scripts/nginx-catalyst.conf` теперь source of truth — если кто-то правит `/etc/nginx/sites-available/catalyst` на VPS вручную, drift молчит. Mitigation: quarterly diff (можно добавить в check-cert-expiry.sh как extra проверку — defer).
- `check-cert-expiry.sh` использует GNU `date -d` — на BSD упадёт. Catalyst prod = Debian/Ubuntu, OK.
- `openssl s_client` external check работает только если domain reachable. Если VPS firewall блочит 443 от себя — manual проверка через certbot certificates.

---
```

- [ ] **Step 7: NO COMMIT (operator decides when to commit Bundle #17 changes).**

---

## Self-Review

After writing the plan, verifying against the spec:

**Spec coverage check:**

| Spec acceptance item | Task | Status |
|---|---|---|
| `scripts/nginx-catalyst.conf` created, matches prod | T1 | covered |
| `scripts/check-cert-expiry.sh` created, exec bit, bash -n | T2 | covered |
| Local test of check-cert-expiry.sh | T2 step 4 (optional) + T7 step 4 (mandatory) | covered |
| DEPLOY.md §4 port drift fix | T3 | covered (4 fixes documented) |
| DEPLOY.md §4.2 Cert renewal SOP | T4 | covered |
| DEPLOY.md §10.1 Secret rotation SOP | T5 | covered (12-key table + procedure) |
| SESSION_CONTEXT.md 3 new bullets | T6 | covered |
| Operator: scp + cron + manual test on VPS | T7 steps 2-5 | covered |
| Operator: verify nginx config matches prod via diff | T7 step 1 | covered |
| WORKLOG entry | T7 step 6 | covered |
| Closed findings recorded | T7 step 6 (entry includes list) | covered |

All spec items have a corresponding task.

**Placeholder scan**: No "TBD", "TODO", or vague directives. Some real-value placeholders exist (`<DAYS>`, `<EXPIRY_DATE>`) — these are intentional, to be filled in at runtime by the operator.

**Type/name consistency**:
- `scripts/nginx-catalyst.conf` — consistent everywhere
- `scripts/check-cert-expiry.sh` — consistent (on VPS as `/usr/local/bin/check-cert-expiry.sh`)
- `/etc/cron.daily/catalyst-cert-check` — consistent
- `/var/log/catalyst-cert.log` — consistent
- WARN_DAYS=14 — consistent (script + docs + WORKLOG)
- Section numbering: §4.2 (cert) + §10.1 (secret rotation) — consistent
- Port allocation: dashboard 8080, admin 8081 — consistent

Plan is self-consistent and matches spec.

---

## Execution Notes

- T1-T6: subagent-driven file work (~45 min total via subagent dispatches)
- T7: operator-driven (~15 min SSH operations + WORKLOG entry)
- **Total elapsed time**: ~1 hour active + light setup overhead

**Operator preferences honored**:
- No commits by subagents (operator commits later)
- VPS install is operator-driven (subagents don't ssh)
- No SPA validators relevant (no src/server.js, src/admin/server.js touched)
- WORKLOG rotation policy (`AGENT_RULES.md §6`) — count after Bundle #17 entry. If total `## 2026-...` headers > 12, run rotation in a separate PR.

**Risks acknowledged**:
- If `scripts/nginx-catalyst.conf` diverges from prod after first commit (someone edits prod directly), drift goes silent. Mitigation: quarterly diff manually, or add to drill procedure later.
- `date -d` is GNU-specific (catalyst-cert-expiry.sh) — Catalyst prod is Debian/Ubuntu (GNU), no portability issue. Documented in script comment.
- Cron MAILTO not assumed — if not configured, operator must check log periodically (documented in §4.2).
