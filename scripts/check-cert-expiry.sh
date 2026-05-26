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
