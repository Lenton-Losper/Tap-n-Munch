# Production deployment strategy & checklist — FlashTap (Cloudflare)

**Status:** Proposed ops documentation (issue #92). Investigation only — no workflow changes in this PR.  
**Companion:** [cloudflare-workers-rollback.md](./cloudflare-workers-rollback.md)  
**Date:** 2026-07-28

---

## Part 2 — Current deployment reality (plain facts)

### What we actually do today

| Fact | Detail |
| --- | --- |
| Production traffic | Cloudflare Worker **`flashtap-production`** on `flashtap.app` / `www` / `riviera` |
| Prod deploy trigger | Manual only: Actions → **Deploy flashtap-production Worker** (`workflow_dispatch`), **must be from `main`** |
| Prod deploy command | `npx wrangler@3.99.0 deploy --config wrangler.production.toml` |
| Cutover model | **Full direct cutover** — new version gets **100%** traffic immediately |
| Gradual rollout / % traffic split | **Not used** |
| Blue/green | **Not used** |
| Staging | Push to `cloudflare-staging` → **Deploy to Cloudflare Staging** (`staging.yml`): build → `wrangler deploy` → HTTP smoke + Jest + Playwright |
| Staging HTTP smoke today | `GET /` and `GET /api/menu/<fixture>/features` must return success |
| Prod post-deploy automated smoke | **None** in `production-worker.yml` (deploy + secret put only) |
| Prod pre-deploy gates | OpenNext build; assert custom domains in toml; **migration drift check** (hard fail) |
| Retired path | `production.yml` (Vercel) is manual/legacy; production traffic is CF-only |

Snapshot at investigation time:

- Production `/api/version` → `9e7c043…` (matches latest successful prod Actions deploy)
- Staging `/api/version` → `6e1e767…` (staging branch tip; often ahead of / different from prod)

### Is “no gradual rollout” accurate?

**Yes.** CI never calls `wrangler versions upload` / `wrangler versions deploy` with percentages. Every production ship is an all-or-nothing cutover.

### Could we adopt Cloudflare gradual rollout without major app rework?

**Yes, as an ops/workflow change — not an application rewrite.**

Cloudflare natively supports:

1. `wrangler versions upload` — publish a version **without** sending traffic  
2. `wrangler versions deploy <new>:10% <old>:90%` (etc.) — split traffic  
3. Promote to 100% when healthy  
4. Rollback still works (forces the selected version to 100%)

**Caveats for this Next.js / OpenNext Worker:**

- HTML/RSC and static assets are versioned together. During a split, clients can hit mismatched versions unless **version affinity** / session stickiness is considered.
- Cron (`*/2 * * * *` → in-process `cleanup-stale-orders`) runs on the Worker; behavior during a split should be understood (which version executes scheduled?).
- Secrets remain Worker-scoped; gradual code rollout does not gradually roll secrets.
- Adopting this means rewriting `production-worker.yml` (and likely adding health gates between %). **Do not flip this on without a deliberate PR** — this doc only notes feasibility.

---

## Proposed production deployment checklist

Use this before every production `workflow_dispatch`. Goal: match what worked repeatedly in practice — **staging genuinely green**, then **explicit prod sign-off**, then **smoke**.

### A. Classify the deploy (do this first)

See [Decision rule: code-only vs includes migration](#decision-rule-code-only-vs-includes-migration). Write the classification in the deploy chat / PR comment:

- `[ ] Code-only`
- `[ ] Includes migration` (list migration version IDs)
- `[ ] Includes secrets / env / wrangler.toml binding changes`
- `[ ] Includes payment / terminal / webhook path changes` (extra smoke required)

### B. Staging must be genuinely green

Not “diff looks fine.” Required:

1. **Real staging deploy** of the same commit(s) you intend to promote (or the merge commit that will land on `main`).
2. Staging Actions **Deploy to Cloudflare Staging** completed successfully for that SHA (or equivalent push to `cloudflare-staging`).
3. **HTTP verification** against live staging, not just local build:
   ```bash
   STAGING=https://flashtap-staging.llosperofficial.workers.dev
   curl -sS "$STAGING/api/version"   # commit matches expected SHA
   curl -sf "$STAGING/" >/dev/null
   curl -sf "$STAGING/api/menu/ade55dd9-ab0d-46c7-9f53-d65f4bed4305/features" >/dev/null
   ```
4. If the change is payment/terminal/orders: run the relevant staging probe/verify job (commit-message tags already used on staging, e.g. Finatic guard, terminal integrity, document engine) **or** manually exercise the path on staging.
5. If **includes migration**: migration applied on **staging** first; staging drift situation understood; app behavior verified **after** migrate.

Do **not** proceed to production if staging deploy failed, smoke failed, or `/api/version` is not the SHA you think it is.

### C. Pre-production gates on `main`

1. Fix/merge is on **`main`** (prod workflow refuses other refs).
2. Diff reviewed; classification from §A recorded.
3. If migration: applied (or explicitly scheduled) on production DB **before** relying on new code — Worker deploy will **hard-fail** if `check-migration-drift.mjs` sees committed-but-unapplied or applied-but-uncommitted versions.
4. Know the rollback target: previous good prod SHA from `https://flashtap.app/api/version` **before** you deploy (save it).

### D. Explicit sign-off (human)

Before clicking **Run workflow** on **Deploy flashtap-production Worker**:

```text
SIGN-OFF
- Staging SHA verified live: ________
- Prod current SHA (pre-deploy): ________
- Classification: code-only / includes-migration / secrets / payments
- Rollback plan if bad: wrangler rollback OR dashboard (see rollback doc)
- Signer: ________
```

No sign-off → no production trigger.

### E. Deploy

1. GitHub Actions → **Deploy flashtap-production Worker** → branch **`main`** → Run.
2. Watch: build → domain assert → **migration drift** → wrangler deploy → secrets.
3. Do not start another prod deploy until this run finishes.

### F. Post-deploy smoke (production) — concrete for this app

Run within a few minutes of green Actions. Minimum set:

```bash
PROD=https://flashtap.app

# 1) Version pin — must equal the SHA just deployed from main
curl -sS "$PROD/api/version"
# expect: {"commit":"<deployed-sha>"}

# 2) Edge / app up on all custom domains
curl -sS -o /dev/null -w 'app:%{http_code}\n' "$PROD/"
curl -sS -o /dev/null -w 'www:%{http_code}\n' https://www.flashtap.app/
curl -sS -o /dev/null -w 'riviera:%{http_code}\n' https://riviera.flashtap.app/

# 3) Cron route mounted (unauthenticated → 401 if CRON_SECRET set)
curl -sS -o /dev/null -w 'cron:%{http_code}\n' -X POST "$PROD/api/cron/cleanup-stale-orders"
```

**Recommended product smokes (pick based on blast radius):**

| Area | What to check |
| --- | --- |
| Menu / kiosk | Load a known restaurant menu URL; confirm features/menu JSON or UI renders |
| Kitchen / orders | Open kitchen board for a test or live restaurant; list orders loads |
| Cron health | Confirm Worker cron still scheduled (`*/2 * * * *` in `wrangler.production.toml`); optional authenticated POST to `/api/cron/cleanup-stale-orders` with `x-cron-secret` in a break-glass shell (do not paste secret into chat logs) |
| Order-flow (code touching orders) | Staging already covered E2E; on prod prefer a **low-risk** path (hosted pending create on a test restaurant if available) — avoid real card charges unless necessary |
| Payments / Finatic / terminal | Only if this deploy touched webhooks, terminal callbacks, or reconcile: one staging-proven path + watch Finatic retries / `orders.payment_events` for anomalies for the next 10–15 minutes |
| Migrations | Hit one code path that exercises the new RPC/table; confirm no PGRST202 / missing-column errors in logs |

If `/api/version` is wrong or smoke fails → execute [rollback runbook](./cloudflare-workers-rollback.md) immediately; do not “wait and see” on payments.

---

## Decision rule: code-only vs includes migration

Use this to classify **any** future deploy in under a minute.

### Code-only (lower risk — can move faster after staging green)

**All** of the following are true:

1. Diff does **not** add/change files under `supabase/migrations/`.
2. No manual SQL / Supabase dashboard schema change is required for the release to work.
3. No new/changed Worker **secrets** or wrangler **bindings** are required (or secrets are unchanged and already present).
4. Drift check would pass both before and after without applying anything new.

**Still required:** staging green + sign-off + post-deploy smoke. Faster means fewer extra DB steps — not skipping staging.

### Includes migration (higher risk — extra caution)

**Any** of the following:

1. New or modified file in `supabase/migrations/`.
2. Production DB must receive SQL (via approved apply path / `apply-ops-migration.yml` / human SQL editor) for the new code to work.
3. Release depends on a new RPC, column, index, RLS policy, or grant that is not already on production.

**Extra required steps:**

1. Apply + verify on **staging** first (including app behavior after migrate).
2. Apply to **production** with explicit human approval **before** or as a coordinated step with the Worker deploy (order matters: usually migrate forward first when additive; never assume rollback undoes SQL).
3. Confirm `check-migration-drift.mjs` will pass against production for the SHA you are about to deploy.
4. Pre-write the [migration rollback thinking](./cloudflare-workers-rollback.md#migrations-code-rollback-does-not-undo-schema) for cases B vs C.
5. Longer soak / tighter smoke on the migrated feature path.

### Adjacent higher-risk buckets (not “migration,” but do not treat as casual code-only)

Treat like elevated caution even without SQL:

- Payment webhook / terminal callback / reconcile / auto-cancel cron
- Auth, RLS, or multi-tenant isolation
- Wrangler routes, cron schedule, or secret rotation
- OpenNext / Worker entry (`workers/flashtap-worker.ts`) changes

---

## What we are **not** changing yet

Per issue #92 investigation scope:

- No edits to `production-worker.yml` / `staging.yml`
- No gradual rollout enablement
- No automated prod smoke job (proposed above as a checklist humans run; CI automation can be a follow-up)
- No forced staging→prod promotion bot

Review this doc, then decide what to adopt.
