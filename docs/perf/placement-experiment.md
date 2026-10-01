# Worker placement experiment (Phase 1 of perf/latency-sprint, 2026-10-01)

**Status: prepared and baseline A measured. B not deployed. Nothing changed in production.**

## The question

Where should the worker run?
- **Today (A):** the worker runs in the colo the terminal enters through, WDH (Windhoek). Every
  database round trip crosses to Supabase in AWS eu-west-1 (Ireland).
- **The alternative (B):** run the worker near Ireland. The terminal then pays the long hop once
  per request, and each database round trip becomes short.

## Measured A (staging, from Windhoek, 2026-10-01)

Measured with `scripts/perf/measure-placement.mjs`: 30 sequential requests per endpoint.

| Endpoint | DB round trips | p50 | p90 | `cf-placement` | Edge |
|---|---|---|---|---|---|
| `/api/version` | 0 | 19 ms | 31 ms | (none) = default placement | WDH |
| `/api/menu/<id>/features` | 1 | 228 ms | 252 ms | (none) | WDH |

**One WDH→Ireland database round trip ≈ 209 ms** (228 − 19). This measurement directly confirms
the "~200 ms per sequential DB call" model used throughout the baseline.

## Expected B. This is a model, NOT a measurement

With the worker near Ireland, the request pays one WDH→Ireland hop. That costs about the same
~200 ms, but it is paid once, and each database round trip drops to a few ms. So:

| Sequential DB depth | A ≈ | B ≈ | Verdict |
|---|---|---|---|
| 0 (`/api/version`) | 20 ms | ~220 ms | **B is worse** |
| 1 | 230 ms | ~225 ms | even |
| 4 (`orders?scope=active`) | ~850 ms | ~240 ms | B better |
| 25 (legacy list, after Phase 2) | ~5.2 s | ~0.3 s + payload | B much better |

Every payment route has a depth between 5 and 22, so the model favours B for them.

The model leaves out several things, which is why it must be measured before anyone acts on it:
- Smart Placement's own decision: it may choose to stay local.
- Static assets: always served at the edge, unaffected.
- Upstash and Finatic: both external and not in Ireland.
- Cold starts.

## How to measure B (staging only)

1. **Generate the variant.** It is derived from `wrangler.toml` and refuses any worker other than
   `flashtap-staging`:
   - `node scripts/perf/make-placement-config.mjs smart` writes
     `wrangler.staging.placement-smart.toml` with `[placement] mode = "smart"`. Wrangler 3.99, the
     repo's version, accepts it.
   - `node scripts/perf/make-placement-config.mjs region` writes
     `wrangler.staging.placement-region.toml` with `[placement] region = "aws:eu-west-1"`. This
     is Cloudflare's documented placement-hint format. **Wrangler 3.99 rejects it**: its schema
     allows only `mode` and `hint`, with `additionalProperties: false`. It needs wrangler 4.x.
2. **Deploy that config to STAGING.** This needs a human's go-ahead; this sprint deployed nothing.
   The build is the usual OpenNext artifact; only `--config` differs.
3. **Smart mode only:** send traffic from more than one location for at least 15 minutes. That is
   Cloudflare's stated analysis time, and Smart Placement needs consistent multi-location traffic
   before it decides.
4. **Confirm placement before reading any timings.** `cf-placement` must read `remote-XXX`. A value
   of `local-XXX`, or no header, means B is not in effect, and its numbers are A's.
5. Run `node scripts/perf/measure-placement.mjs https://flashtap-staging.llosperofficial.workers.dev 30`
   from Windhoek, with `STAGING_TERMINAL_TOKEN` set to a **staging** terminal's access token so the
   terminal endpoints run too. The token comes from the environment and is never printed.
6. **Compare B against A row by row. Do not assume B helps.** `/api/version` is the control, and
   B is expected to make it slower.
7. **Revert staging** by redeploying with plain `wrangler.toml`.

## Production change: NOT applied

Apply this only if B measures better on staging for the terminal endpoints.

`wrangler.production.toml`, top level (before the first `[table]`):

```toml
[placement]
mode = "smart"
```

or, with wrangler ≥ 4.x in the production Docker deploy (production deploys use wrangler 3.99
today):

```toml
[placement]
region = "aws:eu-west-1"
```

Caveats:
- Placement affects `fetch` handlers only. Cloudflare documents that it does not affect RPC or
  named entrypoints.
- The `*/2` cron is not a `fetch` event. Its 27–37 s runs are not addressed by this change.
- Rollback is a redeploy without the block.
