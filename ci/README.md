# ci/

No scripts live here. The workflows in `.github/workflows/` carry their
own steps, and the shared callers (`ci.yml`, `notify-status.yml`,
`scorecard.yml`) delegate to `tabnas/.github`.

To change CI, edit `.github/workflows/` in a reviewed pull request.
Session credentials push workflow files (admin `DECISIONS.md` ADR-8, as
amended 2026-09-24), so staging a workflow here first for a maintainer
to promote is optional. Where admin keeps a template for the file
(`rollout/workflows/mcp__<file>`), mirror the change there at the
same time: admin `scripts/verify.sh` compares the template with the
deployed copy, and a maintainer's next
`rollout/apply-workflows.sh --apply` would push the old text back.
Sessions still cannot push tags, so a maintainer pushes any tag that a
tag-triggered workflow needs.

## Promoted, 2026-09-22

`workflows/docs.yml`, the prose gate, is now `.github/workflows/docs.yml`,
moved by the rollout script rather than edited. Nothing is pending. Read
the workflow itself rather than a description of it here.
