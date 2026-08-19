# Service level — `mcp.tabnas.dev`

Phase 4's exit criteria ask for a defined p99 latency and an error budget.
This is that definition, set from measurement rather than aspiration.

**What this is not.** A contract. `mcp.tabnas.dev` is a free convenience
for agents that cannot spawn a process; the supported path is local stdio
(`npx --yes @tabnas/mcp mcp`), which is faster, private, unlimited and has
no availability question at all. Nothing here is a promise to a paying
customer, because there is no paying customer. It exists so that
"degraded" is a thing we can notice rather than a thing we argue about.

## Measured baseline

`node benchmark/parity.mjs`, from Dublin against the deployed Worker,
2026-08-19, 35 samples across all seven tools plus repeated cheap calls:

| | |
| --- | --- |
| p50 | 24 ms |
| p95 | 41 ms |
| p99 | 79 ms |
| max | 79 ms |

Cold starts are included, not trimmed: a client that hits a cold isolate
pays that latency, so excluding it would measure something no caller
experiences. The Worker's startup time is ~15 ms, and the first call of a
run is typically the slowest (181 ms was observed once).

These are edge-local numbers. A caller in another region pays network on
top; the Worker runs at the nearest data centre, so compute does not move.

## Targets

| | Target | Rationale |
| --- | --- | --- |
| p99 latency | **≤ 250 ms** | ~3× measured, so ordinary variance and cold starts do not breach it. A breach means something changed, not that a request was unlucky. |
| Availability | **99.5% monthly** | ≈ 3h 40m of budget per month. |
| Error rate (5xx) | **< 0.5%** of requests | 4xx is excluded: a 400, 413 or 429 is the service working correctly and saying no. |

`cpu_ms` is capped at 200 in `wrangler.json`, so a request that would
exceed the p99 target on compute is killed by the platform first. The
latency target and the CPU cap are therefore consistent by construction —
tightening one without the other would make the pair incoherent.

## What is excluded from the budget

- **429s.** The rate limit is the service working. A client that hits it
  has a documented, correctable answer and a local alternative.
- **413s and 400s.** Same reasoning: bounded input is a stated contract.
- **Rejections by the grammar firewall (ADR-10).** Refusing to execute a
  supplied `ref` is the single most important thing this service does.
- **Cloudflare edge responses the Worker never sees** — a zone-level WAF
  or Browser Integrity Check block is a zone configuration question, not a
  service one. (One such rule exists: BIC is disabled for this hostname,
  because programmatic clients are the entire legitimate population here.)

## How to re-measure

```bash
cd ts && npm run build          # parity.mjs reads dist/tools.js
node benchmark/parity.mjs       # parity + latency, ~35 requests
```

It asserts byte-parity between local core and the deployed endpoint for
every tool, and reports the percentiles above. **Parity failing is the
serious result** — it means the deployed bundle is not this repo's code,
which is the only way the "one implementation" claim can break once the
tests are green. A short latency sample is reported, not failed.

Two runs inside one minute share the 60/minute per-IP budget; the harness
is sized so a single run cannot trip it, and says so plainly if it does.

## On "staging first"

Phase 4's exit criteria also asked for a staging environment. **This is a
deliberate decision not to build one**, recorded here rather than left as
an open item.

What was tried: per-version preview URLs
(`<version>-tabnas-mcp.<subdomain>.workers.dev`) via `preview_urls: true`.
They 404 with Cloudflare error 1042, because preview URLs are served from
the workers.dev subdomain and `workers_dev: false` disables it. Enabling it
would give this Worker a permanent public `*.workers.dev` hostname — the
exact thing `workers_dev: false` exists to prevent, since it would be a
second, unrate-limited-by-hostname way to reach the same service outside
the documented endpoint. Trading that for a staging URL is a bad deal.

A separate staging Worker is worse again: its own rate-limit binding, its
own config, its own drift, and nothing verified about it would be evidence
about production, because it would not be the same deployment.

What actually provides the assurance staging is *for*:

1. **`test/workerd.test.js`** boots the real `wrangler.json` in real
   workerd on every push. Every deploy-blocking defect this service has had
   was caught by this class of check, and none by a Node test.
2. **`benchmark/parity.mjs`** asserts the DEPLOYED endpoint answers
   byte-identically to local core, across every tool. Run it after any
   deploy.
3. **`wrangler rollback`** is one command, and the previous version is
   always there.

The gap that remains, honestly stated: there is no way to exercise a build
against production infrastructure *before* it takes traffic. For a
stateless service with no database to migrate, no session to drain, and a
one-command rollback, that gap is small — and it is bounded by running
parity immediately after each deploy, which is what the criterion was
really protecting against.

Revisit this if the service ever grows state.

## When a target is missed

There is no pager and no on-call. The honest response, in order:

1. Check `parity.mjs` — if answers diverged, redeploy from `main`.
2. Check Workers observability (enabled in `wrangler.json`) for the shape
   of the failures.
3. If the endpoint is unhealthy and the cause is not immediate, **say so
   on `/mcp`** and point at local stdio. The hosted endpoint being down
   costs users nothing they cannot recover in one command, and pretending
   otherwise is worse than the outage.
