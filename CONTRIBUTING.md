# Contributing to mcp

Thanks for your interest in contributing! The organization-wide conventions
in [tabnas/.github](https://github.com/tabnas/.github/blob/main/CONTRIBUTING.md) are
canonical and apply here. This file adds what is specific to
**tabnas/mcp**.

Start with [`AGENTS.md`](AGENTS.md) — it is the working guide to this
repository for humans and agents alike.

## Build & test

```bash
npm install
npm test
```

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — release
automation derives versions and changelogs from them, so this is required:

```
feat: add lax mode for trailing commas
fix: handle CRLF inside block scalars
docs: clarify plugin ordering
```

Use `feat!:` / `fix!:` (or a `BREAKING CHANGE:` footer) for breaking changes.

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Branch from `main`; keep the PR focused on one change.
3. `make test` must pass.
4. PR titles follow Conventional Commits — PRs are squash-merged, so the
   title becomes the commit message.
5. CI must be green before merge.

## Security issues

Never open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by the org
[Code of Conduct](https://github.com/tabnas/.github/blob/main/CODE_OF_CONDUCT.md).
