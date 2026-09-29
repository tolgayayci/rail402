# Contributing

Issues and pull requests are welcome. For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Set up

Node.js 24.11 or later and pnpm 11 (`corepack enable`, or `mise install`), and Docker for the integration
tests.

```sh
pnpm install
pnpm verify                                 # format, lint, typecheck, unit tests, licence gate
docker compose --profile stellar up -d      # Postgres + a private Stellar network
pnpm test:integration
pnpm eval:check                             # search quality gate, when you touch search
```

## Pull requests

- Keep a change to one concern, with tests for the behaviour it adds or fixes.
- Commit messages are one line in the imperative mood, at most 72 characters: `fix replay check for C…
payers`.
- Every rejection needs a stable code and a reason; add new codes to the registry of the package that raises
  them and document them in `docs/verification-rules.md`.
- New dependencies must be permissively licensed; `pnpm license:gate` checks this.

By contributing you agree that your contribution is licensed under [Apache-2.0](LICENSE).
