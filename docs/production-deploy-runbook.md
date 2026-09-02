# Production deploy runbook

**The short version: build in Docker Linux, prove the artifact, upload at 0%, smoke it, promote,
watch, and know your rollback target before you need it.**

GitHub Actions cannot run while the account's billing is locked, so **today the only working path
is local**. That is also the dangerous path, because a local build on Windows produces an artifact
that passes every build step and 500s every route.

---

## The outage this exists because of

2026-09-01. A Windows-built Worker was uploaded to `flashtap-production`. Every route returned 500.
Rolled back in about three and a half minutes.

`next build` green. OpenNext green. `wrangler deploy` green. The artifact was **~10.4 MB short** —
`handler.mjs` was 2.95 MB where the Linux build produces 13.36 MB, because Windows does not inline
the Turbopack server chunks. Nothing in the toolchain calls that an error.

Diagnosis then cost more than the outage, because a downloaded "known-good" artifact was used as a
baseline and turned out to be the broken upload itself — Cloudflare's content endpoint returns the
**latest** upload, not the version you asked for. **Never use a downloaded artifact as a baseline
unless its identity can be independently proven.**

---

## The one command

Everything below is wrapped in a single sequence that cannot skip its own gates, because the
outage was not caused by a missing check — it was caused by `wrangler deploy` being the shortest
path to production. The safe path is now the short one.

```bash
# 1. build (Docker, always)
# (the full docker command is in step 1 below - it is long, and one copy of it is enough)

# 2. verify + upload at 0% + smoke + record the rollback target, then STOP
npm run deploy:preview

# 3. only when step 2 is clean, and only deliberately
npm run deploy:promote

# if anything 5xxs
npm run deploy:rollback -- <version-id>
```

All three wrap `scripts/deploy/deploy-production.mjs`.

`deploy:preview` moves no customer traffic. `deploy:promote` requires a second flag
(`--i-have-read-the-runbook`) because one flag is a typo away from moving production and two is a
decision. There is no `--force`: a failed stage stops the sequence.

The manual equivalent of each stage is below, for when something needs doing by hand.

## The procedure

### 0. Know where you are

```bash
git rev-parse HEAD                 # the commit you are about to ship
npx wrangler@3.99.0 deployments list --config wrangler.production.toml | tail -20
```

Write down the version currently at 100%. **That is your rollback target.** Do this before you
build, not after something goes wrong.

### 1. Build — Docker Linux, never the host

```bash
docker run --rm \
  -v "D:\dev\flashtap\build:/app" \
  -v flashtap_prod_linux_build_node_modules:/app/node_modules \
  -w /app node:20-bookworm bash /app/scripts/deploy/build-linux.sh
```

The named volume for `node_modules` is not optional: a Windows bind mount puts Windows-resolved
native binaries on the container's path, which is how `npx` ends up running the wrong binary.

`build-linux.sh` refuses to run outside Linux and finishes by running the artifact gate.

### 2. Prove the artifact

```bash
node scripts/deploy/check-opennext-artifact.mjs .open-next
```

Three checks, self-tested before either is trusted:

| Check | Good | The 2026-09-01 artifact |
|---|---|---|
| `handler.mjs` size | 13,374,852 B | 2,954,790 B |
| `outputFileTracingRoot` | `/app` | `D:\dev\flashtap\build` |
| chunk inlining | each appears ≥ 2× | `instrumentation_ts` appears 1× |

**Exit 1 means stop.** Do not upload, do not promote, do not "try it and see".

### 3. Upload at 0% traffic

```bash
npx wrangler@3.99.0 versions upload --config wrangler.production.toml \
  --tag "docker-$(git rev-parse --short HEAD)" \
  --message "0%-traffic candidate; NOT promoted"
```

`versions upload` creates a version and a preview URL and sends **no** customer traffic to it.
`wrangler deploy` does not — it goes straight to 100%.

Note `wrangler` needs `CLOUDFLARE_ACCOUNT_ID` exported, not just the API token: without it, it
tries `/memberships` and fails with a confusing `code: 9106` auth error. `build-linux.sh` sources
`.env.local` with `set -a`, which exports both.

### 4. Smoke the preview

```bash
node scripts/deploy/smoke-preview.mjs <preview-url> --samples 3 \
  --expect "<a string only the new build has>" \
  --absent "<a string only the old build had>"
```

`/api/version`, `/`, `/kitchen` and `/bar`, none of which may 5xx.

**Status codes alone are not enough.** `/kitchen` and `/bar` are client-rendered behind auth: on
2026-09-01 the preview and live returned byte-identical HTML while only one carried the redesign.
Pass `--expect` **and** `--absent` together — expectation alone cannot tell "it shipped" from "the
probe fetched nothing", because an empty bundle satisfies every absence check.

### 5. Promote, explicitly

Only if step 4 was clean.

```bash
npx wrangler@3.99.0 versions deploy --config wrangler.production.toml <version-id>@100 -y
```

### 6. Watch

```bash
node scripts/deploy/smoke-preview.mjs https://flashtap.app --samples 20 \
  --expect "<marker>" --absent "<old marker>"
```

**Sample, do not spot-check.** Worker rollout is gradual: for a couple of minutes a single request
can be served by either version, so one green hit proves nothing. Require unanimity.

### 7. If anything 5xxs

```bash
npx wrangler@3.99.0 versions deploy --config wrangler.production.toml <rollback-target>@100 -y
```

The target is the version you wrote down in step 0. Roll back first, diagnose afterwards.

---

## What is enforced, and where

| Guard | Enforced by | Covers |
|---|---|---|
| Artifact is Linux-built and complete | `scripts/deploy/check-opennext-artifact.mjs` | local build **and** CI |
| The gate still detects | `__tests__/deploy-artifact-gate.test.ts` (8 tests) | every test run |
| Build cannot run on the host | `scripts/deploy/build-linux.sh` refuses non-Linux | local |
| No artifact is ever committed | `/.open-next/` in `.gitignore` | every commit |
| 0% upload → smoke → explicit promote | `.github/workflows/production-worker.yml` | CI, once billing allows |
| No 5xx before or after promotion | `scripts/deploy/smoke-preview.mjs` | both |
| A migration never bundles DDL with a write to live rows | `scripts/check-migration-no-data-write.mjs` | every run |
| The sequence cannot skip its own gates | `scripts/deploy/deploy-production.mjs` | local |
| The sequence still gates | `__tests__/deploy-sequence-gates.test.ts` (13 tests) | every test run |

## Known gaps

- **CI cannot run** while billing is locked. Every gate above exists in the workflow and is
  exercised locally; none of it runs automatically today.
- **The local path is not forced.** Nothing physically stops someone running `wrangler deploy` by
  hand and skipping all of this. What has changed is that the safe path is now the SHORT one —
  `npm run deploy:preview` is fewer keystrokes than the manual sequence and refuses a malformed
  artifact before it uploads. A gate you have to remember is a gate that gets skipped exactly when
  it matters, so the fix was to make remembering unnecessary rather than to add another check.
- `supabase/schema.sql` carries a stale copy of `deduct_recipe_stock` — unrelated to deploys but
  found while writing the stock contract, and it should be regenerated.

---

## Migration rule, ruled 2026-09-02

**A migration must not bundle a schema change with a data write to live rows.**

The halves have different risk profiles. A schema change is reviewable in the diff and reversible
with another DDL statement. A write to production rows is neither: once
`UPDATE restaurants SET vat_rate = 15` has run, the previous values are gone unless somebody
captured them first, and no later migration restores what was never recorded.

Bundling them gets the dangerous half approved on the strength of the safe half. Someone reads
"adds a nullable column", says yes, and ships a data write nobody examined. The fault is not that
the write is wrong — it is that nobody was asked about it separately.

Separate files, separate approvals, separate deploys. The schema lands and is verified; only then
does anyone decide what should be written into it.

Enforced by `scripts/check-migration-no-data-write.mjs`, which self-tests its detectors and then
fails on any NEW migration containing both. Nineteen historical files are baselined by name — the
rule cannot unbundle migrations that ran months ago, and failing over them would just get the check
switched off. A pure backfill is fine (the write IS the review), as is seeding a table the same
file created (there were no live rows a moment earlier).
