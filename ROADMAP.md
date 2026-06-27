# Roadmap

Catalyst is in public OSS preview. The near-term goal is to make the project
easier to understand, run and review without changing its single-operator
architecture.

## Near Term

- Keep README, deployment docs and `.env.example` aligned with the real runtime.
- Add focused tests around scorer provider fallback and payment verification.
- Improve first-run setup for developers who do not have every optional API key.
- Keep GitHub secret scanning, push protection and Dependabot enabled.
- Publish small tagged releases once the public repository settles.

## Security And Reliability

- Keep Solana Pay reference-based verification as the default. The
  manual-transfer amount/time fallback remains operator-only and disabled by
  default; revisit whether it should be removed before promoting paid plans.
- Continue reducing token exposure in browser flows.
- Add more regression checks around URL fetching and SSRF protections.
- Document safe production rotation for Telegram, AI provider and admin keys.

## OpenAI And Codex Workflows

- Use Codex for issue triage, code review assistance and release-note drafts.
- Use OpenAI API credits, if available, for maintainer automation and regression
  evaluation around the AI scoring pipeline.
- Keep AI-generated patches human-reviewed and covered by the same checks as
  handwritten changes.
