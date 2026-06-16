# Open Source Readiness Audit

Date: 2026-06-17

This is a pre-publication audit for turning Catalyst into an open source
repository while preserving the visible development history. It intentionally
does not include secret values.

## Executive Summary

The repository is not ready to publish as-is.

No high-confidence secret formats were found in the current tracked tree during
the custom scan, and `.env` is currently ignored. The first cleanup pass also
replaced real-looking keys in `.env.example` with explicit placeholders.

The first cleanup pass removed internal/private paths from the public tree with
`git rm --cached`, genericized production host/domain/bucket references, and
removed hard-coded public URLs from deploy and Telegram notification code.

The remaining blocker for a history-preserving publication is git history:
older commits still contain private operational context and real-looking
`ADMIN_API_KEY` examples in `.env.example` blobs.

Recommended publication path: keep the history, but clean it with a dedicated
history-rewrite tool, then re-scan the rewritten repository before making it
public.

## Findings

### OSR-001: Private/internal files are tracked

Severity: High

Evidence:

- These paths were tracked before cleanup: `.claude`, `.codex-backups`,
  `ai-context`, `docs/superpowers`, `posts`, `DEPLOYMENT_SUMMARY.txt`, and
  `EvilCatPack`.
- They have been removed from the current public tree with `git rm --cached`
  and added to `.gitignore`.

Impact:

Publishing these files would expose agent session rules, private worklogs,
internal plans, local assistant settings, old source snapshots, and possibly
third-party asset files without clear redistribution evidence. Current-tree
cleanup prevents future commits from carrying them, but old commits still need
history cleanup if history is preserved.

Recommendation:

Keep these files local/private. Before publication with history, remove them
from historical commits with a history-rewrite tool and re-scan.

### OSR-002: Production infrastructure details are present

Severity: High

Evidence:

- `deploy.ps1` and `deploy.sh` previously contained a default root SSH target
  for the production host.
- `DEPLOY.md`, `scripts/nginx-catalyst.conf`, `scripts/check-cert-expiry.sh`,
  internal context, and audit/planning docs referenced the live domain,
  hostnames, SSH commands, backup bucket names, and operational procedures.
- Current public files now use example domains/placeholders instead of the live
  host/domain/bucket.

Impact:

This is not the same as a leaked password, but it gives attackers and random
internet users a map of the production setup.

Recommendation:

Keep real production runbooks in private operator notes or a password manager.
Re-scan history before publication.

### OSR-003: `.env.example` history contains real-looking key values

Severity: Medium

Evidence:

- Current `.env.example` has been changed to use explicit placeholders.
- History scan found 13 generic high-entropy `ADMIN_API_KEY` assignments in
  `.env.example` blobs.
- Local `.env` values for checked secret keys did not match historical
  `.env.example` values.

Impact:

Even if these are examples, readers may treat them as reusable defaults. If any
were ever used in production or staging, they must be considered compromised.

Recommendation:

Rotate any matching live keys before publication. If publishing with history,
rewrite history and re-scan.

### OSR-004: Open source metadata is mostly in place

Severity: Medium

Evidence:

- `package.json` has empty `author`.
- `LICENSE` has been added with MIT.
- `CONTRIBUTING.md` has been added.
- `SECURITY.md` and `.github/dependabot.yml` have been added.
- `README.md` now points to the MIT license.

Impact:

The project is now legally clear enough for a first public release, but owner
metadata can still be improved.

Recommendation:

Fill in package `author` if desired, and expand contributor docs after the
first public release.

### OSR-005: Dependency audit has production vulnerabilities

Severity: Medium

Evidence:

- `npm audit --omit=dev` reports 10 vulnerabilities: 2 critical, 1 high, 7
  moderate.
- The main chain is `node-telegram-bot-api -> request/form-data/qs`.
- `lodash` also reports high/moderate advisories.

Impact:

Publishing with known vulnerabilities is not automatically fatal, but public
users will see the audit output immediately.

Recommendation:

Triage before release. The `node-telegram-bot-api` fix is a breaking major
upgrade, so it needs testing. `lodash` may be fixable with a normal audit fix.

### OSR-006: Asset licensing is unclear

Severity: Medium

Evidence:

- `EvilCatPack` contains 536 tracked image files.
- No license/readme/credits file was found inside `EvilCatPack`.

Impact:

Redistributing third-party art without a clear license can create copyright
trouble even when the code license is valid.

Recommendation:

Either remove `EvilCatPack` from the public repo, add verifiable licensing and
attribution, or replace it with assets you own.

### OSR-007: Local auth tokens are stored in browser localStorage

Severity: Low to Medium

Evidence:

- Dashboard stores `ts_auth_token` in `localStorage`.
- Admin stores `adminKey` in `localStorage`.

Impact:

Any XSS would expose these tokens. This may be acceptable for a solo/operator
tool, but public users should know the tradeoff or the flow should move to a
more robust session design.

Recommendation:

Document this in security notes or redesign auth before promoting the project
as production-ready for third parties.

## Recommended Release Strategy

1. Rotate secrets before publication if there is any doubt.
2. Keep the sanitized working tree on `main`.
3. Rewrite history to remove internal/private files and old real-looking
   example keys while preserving the visible development timeline.
4. Re-scan the rewritten repository with gitleaks or TruffleHog.
5. Publish the cleaned repository and turn on GitHub secret scanning and
   Dependabot.

## Proposed Public Exclude List

Review and remove from the public release:

- `.claude/`
- `.codex-backups/`
- `ai-context/`
- `docs/superpowers/`
- `posts/`
- `DEPLOYMENT_SUMMARY.txt`
- `EvilCatPack/` unless licensing is confirmed
- production-specific deploy defaults and nginx/cert scripts

## Scan Notes

Custom scans performed:

- Current tracked tree scan for common secret formats.
- Git history unique text blob scan for common secret formats.
- Search for production host/domain references.
- Search for internal tracked file groups.
- `npm audit --omit=dev`.

Limitations:

- `gitleaks` is not installed locally, so this should be followed by a real
  gitleaks or TruffleHog scan before publishing.
- The custom scanner avoids printing secret values and is intentionally
  conservative.
