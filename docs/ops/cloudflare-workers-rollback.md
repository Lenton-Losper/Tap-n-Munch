# Cloudflare Workers rollback — flashtap-production

**Status:** Investigation / proposed runbook (issue #92). Not yet adopted as mandatory ops policy.  
**Scope:** Worker code rollback only. Does **not** undo Supabase schema changes.  
**Date of investigation:** 2026-07-28. **Empirically re-verified:** 2026-07-28 (same day, later session — see verification note below).  
**Live production Worker:** `flashtap-production` (`wrangler.production.toml`) → `https://flashtap.app`  
**Deploy path today:** GitHub Actions `production-worker.yml` → `npx wrangler@3.99.0 deploy --config wrangler.production.toml` (immediate 100% cutover).

---

## Part 1 findings (summary)

| Question | Answer |
| --- | --- |
| Does CF retain previous Worker versions? | **Yes.** Cloudflare retains the **100 most recently published versions** for rollback (raised from 10 on 2025-09-11). **Verified** against the official changelog directly — entry confirms 10→100, and that both dashboard and Wrangler can promote any of the 100 to active. |
| How to view history? | Dashboard: Workers & Pages → `flashtap-production` → **Deployments**. CLI: `wrangler deployments list` / `wrangler versions list` with production config + API token. **Verified**: ran `npx wrangler@3.99.0 deployments list --config wrangler.production.toml` for real — see real output below. |
| Fast redeploy of a prior version? | **Yes.** `wrangler rollback [version-id]` (or dashboard “Rollback”) immediately creates a new deployment that serves that version at 100%. Omitting the ID rolls back to the previous deployment. **Verified**: ran `wrangler rollback --help` for real against the pinned `wrangler@3.99.0` — exact signature is `wrangler rollback [version-id] [-m/--message]`, matching the usage below. (Command was **not executed** — `--help` only; an actual rollback was out of scope for this investigation.) |
| Has this project ever tested CF rollback? | **No evidence found — confirmed with real data, not just absence-of-grep.** Pulled the actual `deployments list` for both `flashtap-production` and `flashtap-staging` (see below): every entry's `Source` is `Unknown (deployment)` or `Secret Change`. Zero entries show a rollback-sourced deployment. Git history, workflows, and docs also only show `wrangler deploy`. |
| Can we list live version IDs from this agent? | **Yes, as of this re-verification** — this agent has an authenticated local `wrangler` session (`llosperofficial@gmail.com`) with real deploy/list access to both Workers, separate from the CI `CLOUDFLARE_API_TOKEN_SHADOW`. Real list output captured below. A break-glass shell for an on-call human should still use the CI-class token or their own authenticated `wrangler login`. |

Official refs:

- [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
- [Changelog: rollback limit 10 → 100](https://developers.cloudflare.com/changelog/post/2025-09-11-increased-version-rollback-limit/) — fetched and confirmed directly: *"100 most recent versions... a tenfold increase from the prior threshold of 10 versions"*, both dashboard and Wrangler supported.

### Real verification output (2026-07-28, later same-day session)

```
$ npx wrangler@3.99.0 deployments list --config wrangler.production.toml
Created:     2026-07-28T21:39:12.245Z
Author:      llosperofficial@gmail.com
Source:      Unknown (deployment)
Version(s):  (100%) 8b44067b-1588-445f-bc60-ced5a0f02932
                 Created:  2026-07-28T21:39:09.540Z
...
(10 most recent shown; every Source across prod and staging is
"Unknown (deployment)" or "Secret Change" — never "Rollback")

$ npx wrangler@3.99.0 rollback --help
wrangler rollback [version-id]
🔙 Rollback a deployment for a Worker
POSITIONALS
  version-id  The ID of the Worker Version to rollback to  [string]
OPTIONS
      --name     The name of your Worker  [string]
  -m, --message  The reason for this rollback  [string]
  -y, --yes      Automatically accept defaults to prompts  [boolean] [default: false]

$ npx wrangler@3.99.0 versions --help
COMMANDS
  wrangler versions view <version-id>
  wrangler versions list                      List the 10 most recent Versions
  wrangler versions upload                    Uploads Worker code+config as a new Version (no traffic)
  wrangler versions deploy [version-specs..]   Split traffic between multiple Versions
  wrangler versions secret
```

Repo secrets confirmed present (names only, `gh secret list`): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_TOKEN_SHADOW`, `CLOUDFLARE_ACCOUNT_ID` — the CI token class this runbook assumes for break-glass access does exist.

---

## How version history works for us

1. Every successful `wrangler deploy` publishes a **version** and immediately makes it the **active deployment** (100% traffic). That is what `production-worker.yml` does today.
2. Cloudflare keeps up to **100** recent versions available for rollback / gradual split.
3. A rollback does **not** delete the bad version; it creates a **new deployment** pointing at an older version. Deployment history still shows the incident deploy and the rollback.
4. Worker **secrets** (`CRON_SECRET`, `TERMINAL_JWT_SECRET`, `RESEND_API_KEY`, etc.) are Worker-scoped bindings updated by `wrangler secret put` in CI after deploy. Rolling back code typically **keeps current secrets**; it does not re-run the GitHub “Set Cloudflare worker secrets” step. If the incident was a bad secret value, fix secrets separately — code rollback alone will not help.
5. OpenNext **assets** ride with the Worker version. Rolling back restores the matching asset bundle for that version (good). Gradual traffic splits can still serve mixed HTML/asset versions unless version affinity is used — see deployment strategy doc.

### View history (before you need it)

**Dashboard**

1. Cloudflare Dashboard → Workers & Pages → **flashtap-production**
2. Open **Deployments** (versions + active deployment)
3. Note version IDs / timestamps / commit annotations if present

**CLI** (from repo root, with account token that can read this Worker):

```bash
export CLOUDFLARE_API_TOKEN=…   # same class of token as CI CLOUDFLARE_API_TOKEN_SHADOW
export CLOUDFLARE_ACCOUNT_ID=b74d9cfb3ba0e345287429ca237ecbfd

npx wrangler@3.99.0 deployments list --config wrangler.production.toml
npx wrangler@3.99.0 versions list --config wrangler.production.toml
# optional detail:
npx wrangler@3.99.0 versions view <version-id> --config wrangler.production.toml
```

**Correlate with git / Actions**

- Live commit: `curl -sS https://flashtap.app/api/version` → `{"commit":"<sha>"}`
- Recent prod deploys: GitHub → Actions → **Deploy flashtap-production Worker** (manual `workflow_dispatch` from `main` only)

---

## Incident rollback procedure (proposed)

Use this when production is broken **and** the last Worker deploy is the likely cause. Prefer the **known-good previous version** over “rebuild main from memory.”

### 0. Triage (2–5 minutes)

1. Confirm blast radius: is `https://flashtap.app` failing for real users (orders, menu, kitchen, payments)?
2. Record current SHA:
   ```bash
   curl -sS https://flashtap.app/api/version
   ```
3. Classify the last change (see [deployment-checklist.md](./deployment-checklist.md)):
   - **Code-only** → Worker rollback is usually enough.
   - **Includes migration** → Worker rollback may be unsafe or incomplete; jump to [Migrations](#migrations-code-rollback-does-not-undo-schema) before rolling back blindly.
4. Pick a known-good target: previous successful Actions run SHA on `main`, or the version that was live before the bad deploy.

### 1. Choose rollback path

**Path A — Wrangler (fastest if you have the token locally or in a break-glass shell)**

```bash
cd /path/to/Tap-n-Munch
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=b74d9cfb3ba0e345287429ca237ecbfd

# List, identify the good VERSION id (not necessarily the git SHA)
npx wrangler@3.99.0 deployments list --config wrangler.production.toml

# Rollback to previous deployment (no id) OR to a specific version
npx wrangler@3.99.0 rollback --config wrangler.production.toml -m "incident: revert bad deploy <bad-sha>"
# or:
npx wrangler@3.99.0 rollback <version-id> --config wrangler.production.toml -m "incident: restore <good-sha>"
```

**Path B — Cloudflare Dashboard**

1. Workers & Pages → **flashtap-production** → **Deployments**
2. Select the last known-good version → **Rollback** (wording may be “Rollback to this version”)
3. Confirm; wait for active deployment to update

**Path C — Re-deploy an older git SHA via Actions (slower, but familiar)**

1. Only if Wrangler/dashboard rollback is unavailable
2. Temporarily check out the known-good commit on `main` history and run **Deploy flashtap-production Worker** from that ref — **today the workflow forces `ref: main`**, so this path requires either a hotfix revert commit on `main` or a one-off workflow change. Prefer Path A/B for true incidents.
3. Practical Actions fallback without workflow edits: push a **revert PR** to `main`, merge, then `workflow_dispatch` production deploy. Slower than `wrangler rollback`.

### 2. Verify immediately

```bash
# Must show the known-good commit, not the bad one
curl -sS https://flashtap.app/api/version

# Basic HTTP
curl -sS -o /dev/null -w '%{http_code}\n' https://flashtap.app/
curl -sS -o /dev/null -w '%{http_code}\n' https://www.flashtap.app/
curl -sS -o /dev/null -w '%{http_code}\n' https://riviera.flashtap.app/

# Cron route should reject unauthenticated callers (proves route is up)
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://flashtap.app/api/cron/cleanup-stale-orders
# expect 401 when CRON_SECRET is configured
```

Then do a **minimal product smoke** appropriate to the incident (menu load for an affected restaurant, kitchen board open, one test terminal/order path on staging if prod is too risky). Full checklist: [deployment-checklist.md](./deployment-checklist.md).

### 3. Stabilize and communicate

1. Leave production on the rolled-back version until a fixed forward deploy is ready.
2. Note: the next `production-worker.yml` run from current `main` will **cut over again** to whatever is on `main`. Do not re-trigger production until the bad commit is reverted or fixed on `main`.
3. File / update the incident note (what broke, version IDs, whether DB was involved).

### 4. Optional: practice this once on staging

Staging Worker uses `wrangler.toml` / `flashtap-staging`. A non-prod `wrangler rollback` drill there is the right way to validate CLI + dashboard muscle memory **before** a production incident. This has **not** been done yet for this project.

---

## Migrations: code rollback does not undo schema

**Hard rule:** Rolling back the Worker restores old application code. It does **not** reverse Supabase migrations. Schema stays where the last applied migration left it.

Production already blocks Worker deploys when local `supabase/migrations/` and the production DB disagree (`scripts/check-migration-drift.mjs` in `production-worker.yml`). That gate prevents shipping code that expects missing RPCs/tables — it does **not** provide a down-migration.

### Case-by-case thinking

| Situation | Safe Worker rollback? | What else is needed |
| --- | --- | --- |
| **A. Code-only bug** (no migration in the bad release) | **Yes** — Path A/B. | Fix forward or keep rolled back until revert lands on `main`. |
| **B. Migration already applied; new code is broken; old code still works against the new schema** (additive columns, new nullable fields, new RPC unused by old code) | **Usually yes** — roll Worker back. | Leave migration applied. Do **not** try to “undo” SQL unless there is a reviewed down plan. Drift check: after rollback, `main` may still contain the migration file; DB remains applied — OK. Re-deploying unfixed `main` will redeploy bad code. |
| **C. Migration already applied; old code cannot run on new schema** (renamed/dropped columns, stricter constraints, replaced RPC signatures) | **No blind rollback.** Rolling back code will likely make production *worse* (queries fail against new schema). | Prefer **forward fix** (hotfix Worker that understands new schema). Only consider schema repair with an explicit, reviewed SQL plan on a maintenance window — never improvise down-migrations under pressure. |
| **D. Migration applied but incomplete / wrong data backfill** | Worker rollback alone is insufficient. | Treat as data incident: stop writes if needed, repair data with a one-off script/SQL, then deploy corrected code. |
| **E. Bad deploy blocked by drift check (never shipped)** | N/A | No Worker rollback needed. Fix migrations/apply process first (`apply-ops-migration.yml` / human-approved SQL). |

### Pre-rollback question (ask out loud)

> “Did this release include a Supabase migration that is already applied on production?”

- If **no** → roll back Worker freely.
- If **yes** → answer: “Will the previous Worker build still function against the current schema?” If unsure, **do not** roll back; hotfix forward or escalate before touching schema.

---

## Gaps called out by this investigation

1. **No practiced rollback** on Cloudflare for this project — confirmed via real `deployments list` on both prod and staging (zero rollback-sourced entries ever). Recommend one staging drill (Part 1 §4) before relying on this runbook in a real incident — command syntax is verified, but the human muscle-memory step is not.
2. **No CI helper** to print recent production version IDs alongside `/api/version` after deploy.
3. **Actions fallback is weak** for true rollback (`production-worker.yml` always checks out `main`) — Wrangler/dashboard is the real break-glass path.
4. ~~Issue #92 was not readable from this agent's GitHub token~~ — resolved in the later verification session; issue #92 body confirms this doc's scope matches what was asked (rollback options, procedure, migration caveat, deploy-process tightening).
5. ~~This agent could not dump live `wrangler deployments list` output~~ — resolved: a later session had an authenticated local `wrangler` session and captured real output (above) for both `flashtap-production` and `flashtap-staging`.

---

## Explicit non-goals of this document

- No changes to `production-worker.yml`
- No adoption of gradual rollout (see [deployment-checklist.md](./deployment-checklist.md))
- No automated rollback on failed smoke tests
