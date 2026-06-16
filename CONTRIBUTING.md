# Contributing

Thanks for your interest in Catalyst.

This project is still being prepared for its first public open source release,
so contribution flow is intentionally lightweight for now.

## Before You Start

- Open an issue before larger changes, new integrations, billing changes, or
  security-sensitive work.
- Keep production secrets, provider keys, hostnames, and private runbooks out
  of git.
- Run the relevant checks before opening a pull request.

## Local Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in your own development keys.
4. Run `npm run dev`.

## Checks

Run:

```bash
npm run check
```

If you edit `src/dashboard/server.js` or `src/admin/server.js`, this check is
required because both files embed large inline React apps inside template
literals.

## Security

Do not report vulnerabilities in public issues. See `SECURITY.md`.
