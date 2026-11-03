# Contributing

Thanks for helping.

- **DCO sign-off:** by contributing, you certify the [Developer Certificate of Origin](https://developercertificate.org/). Sign off each commit with `git commit -s`, which adds a `Signed-off-by: Name <email>` line.
- **License:** contributions are accepted under Apache-2.0.
- **Branching:** work on a branch and open a PR to `main`.
- **Tests:** a change comes with its tests (`pnpm test`).
- **No secrets, no third-party code:** no API keys and no code from other projects. Fixtures must be synthetic.

## Local development

Use Node 22+ and pnpm (the version is pinned in `package.json`). From a checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Tests use fake providers and synthetic fixtures; they do not spend provider quota.
