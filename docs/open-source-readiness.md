# Open Source Readiness Notes

Date: 2026-06-28

This is the public readiness note for Catalyst's first open-source preview. It
summarizes the repository cleanup that was done before publication and the
operator caveats that still matter for anyone running their own instance. It
intentionally does not include secret values.

## Executive Summary

The repository is ready for a public preview, with the normal caveat that
production operation still requires an experienced owner with their own API
keys, Telegram bots, Solana wallet, domain and VPS.

No high-confidence secret formats were found in the tracked tree during the
custom scan, `.env` is ignored, and `.env.example` uses explicit placeholders.
Internal/private agent state, local source asset packs, generated logs and
runtime databases are excluded from version control.

Public-facing repository docs, GitHub contribution templates, a CI workflow,
package metadata, license, security policy and Dependabot configuration are in
place for the first OSS release.

## Findings

### OSR-001: Private/internal files were tracked

Severity: Resolved in the current tracked tree

Evidence:

- These paths were tracked before cleanup: `.claude`, `.codex-backups`,
  `ai-context`, `docs/superpowers`, `posts`, `DEPLOYMENT_SUMMARY.txt`, and
  `EvilCatPack`.
- They have been removed from the current public tree with `git rm --cached`
  and added to `.gitignore`.
- Local rewritten history now reports 0 matches for these paths.

Impact:

Publishing these files would expose agent session rules, private worklogs,
internal plans, local assistant settings, old source snapshots, and possibly
third-party asset files without clear redistribution evidence.

Recommendation:

Keep these files local/private. If history is rewritten again, verify GitHub no
longer has old refs that point to excluded private paths.

### OSR-002: Production infrastructure details were present

Severity: Resolved in the current tracked tree

Evidence:

- `deploy.ps1` and `deploy.sh` previously contained a default root SSH target
  for the production host.
- `DEPLOY.md`, `scripts/nginx-catalyst.conf`, `scripts/check-cert-expiry.sh`,
  internal context, and audit/planning docs referenced the live domain,
  hostnames, SSH commands, backup bucket names, and operational procedures.
- Current public files and rewritten history now use example
  domains/placeholders instead of the live host/domain/bucket.

Impact:

This is not the same as a leaked password, but it gives attackers and random
internet users a map of the production setup.

Recommendation:

Keep real production runbooks in private operator notes or a password manager.
Re-scan GitHub if repository history is rewritten again.

### OSR-003: `.env.example` history contained real-looking key values

Severity: Resolved locally / rotate if any doubt

Evidence:

- Current `.env.example` has been changed to use explicit placeholders.
- Historical real-looking `ADMIN_API_KEY` / `DASHBOARD_API_KEY` examples were
  rewritten to placeholders.
- Local `.env` values for checked secret keys did not match historical
  `.env.example` values.

Impact:

Even if these are examples, readers may treat them as reusable defaults. If any
were ever used in production or staging, they must be considered compromised.

Recommendation:

Rotate any matching live keys before publication if there is any doubt.

### OSR-004: Open source metadata is in place

Severity: Resolved

Evidence:

- `package.json` has repository, bugs, homepage, author, license and Node
  engine metadata.
- `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `MAINTAINERS.md`, `ROADMAP.md`, issue templates, a pull request template and
  a GitHub Actions CI workflow are present.
- `README.md` points to the MIT license and the current Catalyst repository.

Impact:

The project has the expected public metadata for a first open-source preview.

Recommendation:

Keep these files current when repository URLs, support channels or release
processes change.

### OSR-005: Dependency audit had production vulnerabilities

Severity: Resolved locally / verify after push

Evidence:

- Before cleanup, `npm audit --omit=dev` reported 10 vulnerabilities: 2
  critical, 1 high, 7 moderate.
- GitHub Dependabot alerts are enabled and reported 10 open alerts before the
  local dependency update.
- GitHub Dependabot security updates are enabled.
- The vulnerable chain was `node-telegram-bot-api -> request/form-data/qs`.
- `node-telegram-bot-api` was upgraded to 1.1.0.
- Local `npm audit --omit=dev` now reports 0 vulnerabilities.

Impact:

The public repository should stop showing these Dependabot alerts after the
dependency update lands on the default branch and GitHub rescans the lockfile.

Recommendation:

Keep Dependabot enabled and verify GitHub alerts after dependency updates land
on the default branch.

### OSR-008: GitHub secret scanning is enabled

Severity: Resolved

Evidence:

- The repository is public.
- GitHub secret scanning is enabled.
- GitHub secret scanning push protection is enabled.
- GitHub secret scanning currently reports 0 open alerts.

Impact:

GitHub will scan pushes/history for supported secret patterns and block known
secret leaks before they land when push protection detects them.

Recommendation:

Keep secret scanning and push protection enabled.

### OSR-006: Asset licensing is limited to reviewed public assets

Severity: Medium / operational caveat

Evidence:

- `EvilCatPack` is excluded from the tracked public tree.
- The public tree keeps only the selected generated mascot assets under
  `assets/cats/`.

Impact:

The code repository no longer redistributes the source asset pack, but the
maintainer should keep provenance notes for mascot assets outside the public
tree.

Recommendation:

For broader commercial reuse, add explicit asset attribution/licensing notes or
replace mascot art with assets owned by the project.

### OSR-007: Browser and DB auth-token exposure

Severity: Partially resolved

Evidence:

- Dashboard now keeps `ts_auth_token` in `sessionStorage`, removes the legacy
  `localStorage` key on load, and no longer places bearer tokens in avatar or
  SSE URLs.
- Dashboard auth sessions now store `token_hash` instead of new plaintext
  bearer tokens. Legacy plaintext tokens migrate to `token_hash` on use.
- Admin still stores `adminKey` in `localStorage`; admin is designed as an
  operator-only, loopback/SSH-tunnel surface.

Impact:

XSS would still be serious because browser JavaScript must attach the bearer
token to API calls, but long-lived dashboard tokens are no longer persisted in
localStorage or leaked through query strings.

Recommendation:

For third-party production use, consider a full session-cookie + CSRF design or
a frontend bundle split that supports a stricter CSP/Trusted Types posture.

### OSR-009: Solana Pay manual-transfer fallback is gated

Severity: Resolved with operator caveat

Evidence:

- `src/billing/solana-pay.js` now performs reference-based Solana Pay
  verification by default.
- The manual-transfer amount/time fallback runs only when
  `SOLANA_PAY_MANUAL_FALLBACK=1` is explicitly configured.
- `.env.example`, `SECURITY.md` and `ROADMAP.md` describe the fallback as
  operator-only and disabled by default.

Impact:

Reference-based Solana Pay verification remains the safe default. Amount/time
matching can still be ambiguous if an operator enables the fallback, so that
mode should be treated as higher risk and monitored manually.

Recommendation:

Keep `SOLANA_PAY_MANUAL_FALLBACK=0` for normal deployments. Before promoting
paid plans broadly, decide whether the fallback should be removed entirely or
kept as a documented manual-review workflow.

### OSR-010: Public repository presentation is prepared

Severity: Resolved

Evidence:

- `README.md` now explains the project purpose, pipeline, architecture,
  OpenAI/GPT usage, Codex-assisted maintenance workflow, setup, deployment,
  contribution flow, security policy and roadmap.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `MAINTAINERS.md`,
  `ROADMAP.md`, issue templates, a pull request template and CI workflow are
  present.
- `package.json` now has repository, bugs, homepage, author and Node engine
  metadata.

Impact:

The public repository now gives reviewers a clearer picture of what the project
does, how it is maintained, how contributors should engage, and how AI/Codex
fits into the project without making unsupported claims.

Recommendation:

Use the README and ROADMAP wording as source material for the Codex for OSS
application fields, especially the API-credit and maintainer-workflow answers.

## Recommended Release Strategy

1. Rotate secrets before publication if there is any doubt.
2. Keep the sanitized working tree on `main`.
3. Re-scan the GitHub repository with gitleaks or TruffleHog.
4. Verify GitHub Dependabot alerts after dependency updates land.
5. Verify the GitHub Actions CI workflow after the next push.
6. Prepare and submit the Codex for OSS application.

## Proposed Public Exclude List

Keep excluded from the public release:

- `.claude/`
- `.codex-backups/`
- `ai-context/`
- `docs/superpowers/`
- `posts/`
- `DEPLOYMENT_SUMMARY.txt`
- `EvilCatPack/`
- production-specific deploy defaults and nginx/cert scripts

## Scan Notes

Custom scans performed before and after local history rewrite:

- Current tracked tree scan for common secret formats.
- Git history unique text blob scan for common secret formats.
- Search for production host/domain references.
- Search for internal tracked file groups.
- `npm audit --omit=dev`.
- GitHub Dependabot alerts: enabled, 10 open alerts before local dependency
  cleanup.
- GitHub Dependabot security updates: enabled.
- Pull request template: `.github/pull_request_template.md`.
- GitHub Actions CI workflow: `.github/workflows/ci.yml`.
- Local `npm audit --omit=dev` after dependency cleanup: 0 vulnerabilities.
- GitHub repository visibility: public.
- GitHub secret scanning: enabled.
- GitHub secret scanning push protection: enabled.
- GitHub secret scanning open alerts: 0.
- Post-rewrite path scan for excluded internal paths: 0 findings.
- Post-rewrite old production string scan: 0 findings.
- Post-rewrite `.env.example` bad API key line scan: 0 findings.
- Post-rewrite common secret-format scan: 0 findings.

Limitations:

- `gitleaks` is not installed locally, so this should be followed by a real
  gitleaks or TruffleHog scan before publishing.
- The custom scanner avoids printing secret values and is intentionally
  conservative.
