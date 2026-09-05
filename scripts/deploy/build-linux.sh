#!/usr/bin/env bash
# Build the OpenNext artifact for production. RUNS INSIDE node:20-bookworm.
#
# THIS IS THE ONLY SANCTIONED BUILD PATH FOR A PRODUCTION ARTIFACT.
#
# A Windows-built artifact silently omits ~10.4 MB of inlined Turbopack server chunks and 500s
# every route. It took production down on 2026-09-01 with a green build, a green OpenNext step and
# a green wrangler deploy. scripts/deploy/check-opennext-artifact.mjs is what refuses it; this is
# what avoids producing it in the first place.
#
# Invoke from the host (PowerShell or bash), from the repo root:
#
#   docker run --rm \
#     -v "<ABSOLUTE REPO PATH>:/app" \
#     -v flashtap_prod_linux_build_node_modules:/app/node_modules \
#     -w /app node:20-bookworm bash /app/scripts/deploy/build-linux.sh
#
# The named volume for node_modules matters: a Windows bind mount would put Windows-resolved
# native binaries in the container's path, which is how `npx` ends up running the wrong thing.
set -euo pipefail

echo "=== container ==="
echo "  uname : $(uname -sr)"
echo "  node  : $(node --version)"
echo "  npm   : $(npm --version)"
echo "  cwd   : $(pwd)"

case "$(uname -s)" in
  Linux) ;;
  *)
    echo "REFUSING: this script must run inside a Linux container, not on $(uname -s)."
    exit 1
    ;;
esac

# .env.local is copied from a Windows checkout, so strip CR before sourcing or every value picks
# up a trailing \r -- which would silently corrupt CLOUDFLARE_API_TOKEN into an auth failure that
# looks like a permissions problem.
if [ -f /app/.env.local ]; then
  set -a
  # shellcheck disable=SC1090
  . <(tr -d '\r' < /app/.env.local)
  set +a
  echo "  env   : .env.local sourced (CLOUDFLARE_API_TOKEN length ${#CLOUDFLARE_API_TOKEN})"
else
  echo "  env   : no .env.local — the upload step will need credentials from elsewhere"
fi

# ---------------------------------------------------------------------------
# TARGET. Defaults to production, so nothing about the existing path changes.
#
# NEXT_PUBLIC_* IS INLINED INTO THE CLIENT BUNDLE AT BUILD TIME, not read at runtime. A build made
# with production values and deployed to the staging Worker would serve a browser bundle that talks
# to the PRODUCTION database — the Worker's own [vars] cannot correct that, because the value is
# already baked into the JavaScript the customer downloads.
#
# So the staging target overrides them explicitly AFTER .env.local has been sourced (that file is
# production, and `set -a` would otherwise win). The token and account id still come from
# .env.local: the Cloudflare account is the same, only the app's data plane differs.
# ---------------------------------------------------------------------------
FLASHTAP_BUILD_TARGET="${FLASHTAP_BUILD_TARGET:-production}"
echo "=== target: ${FLASHTAP_BUILD_TARGET} ==="

if [ "$FLASHTAP_BUILD_TARGET" = "staging" ]; then
  : "${STAGING_SUPABASE_URL:?staging build needs STAGING_SUPABASE_URL}"
  : "${STAGING_SUPABASE_ANON_KEY:?staging build needs STAGING_SUPABASE_ANON_KEY}"
  export NEXT_PUBLIC_SUPABASE_URL="$STAGING_SUPABASE_URL"
  export NEXT_PUBLIC_SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY"
  export SUPABASE_URL="$STAGING_SUPABASE_URL"
  export SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY"
  export NEXT_PUBLIC_APP_URL="https://flashtap-staging.llosperofficial.workers.dev"
  export NEXT_PUBLIC_BASE_URL="https://flashtap-staging.llosperofficial.workers.dev"
  echo "  client bundle will point at: $NEXT_PUBLIC_SUPABASE_URL"
elif [ "$FLASHTAP_BUILD_TARGET" != "production" ]; then
  echo "REFUSING: unknown FLASHTAP_BUILD_TARGET '$FLASHTAP_BUILD_TARGET' (expected staging|production)."
  exit 1
else
  echo "  client bundle will point at: ${NEXT_PUBLIC_SUPABASE_URL:-<from .env.local>}"
fi

# ---------------------------------------------------------------------------
# npm ci, AND THE ONE WAY TO SKIP IT.
#
# WHY AN OPT-OUT EXISTS. This is the only step in the build that has ever failed on the machine
# that runs it. Twice on 2026-09-05, the host killed the run during `npm ci` under memory pressure
# -- and a killed build leaves the PREVIOUS artifact in .open-next, complete and valid, which then
# passes every gate and ships under the new commit's tag. So the reliability of this step is not a
# convenience question; it is what stops a stale artifact reaching production.
#
# WHEN SKIPPING IS SAFE, AND IT IS NARROW. node_modules is a named Docker volume that survives
# between builds. If it was installed from EXACTLY the package-lock.json we are about to build
# against, `npm ci` is a no-op that deletes the tree and reinstalls it byte for byte. The stamp
# below records which lockfile produced the install, so "exactly" is checked rather than assumed.
#
# IT REFUSES RATHER THAN FALLING BACK. If you asked to skip and it cannot be shown safe, the build
# STOPS. It does not quietly run `npm ci` instead: you asked to skip because the full install is
# what fails here, so silently doing the slow, failing thing is the worst of both.
#
# THE STAMP LIVES IN node_modules, NOT IN THE REPO, deliberately -- it describes the INSTALLED
# TREE, so it must travel with the volume and vanish when the volume does. A stamp in the repo
# would still be there after somebody deleted node_modules, and would then be a lie.
#
# BOOTSTRAP: an install made before this change has no stamp, so the first build after it must run
# `npm ci` once (and will write one). That is correct: an unstamped tree is one nothing can vouch
# for, and skipping on it would be trusting an assertion nobody made.
# ---------------------------------------------------------------------------
LOCK_SHA="$(sha256sum package-lock.json | cut -d' ' -f1)"
STAMP="node_modules/.flashtap-lockfile-sha256"

if [ "${FLASHTAP_SKIP_NPM_CI:-0}" = "1" ]; then
  echo "=== npm ci (skip requested) ==="
  if [ ! -d node_modules ] || [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
    echo "REFUSING to skip npm ci: node_modules is missing or empty."
    echo "  There is nothing installed to reuse. Re-run without FLASHTAP_SKIP_NPM_CI=1."
    exit 1
  fi
  if [ ! -f "$STAMP" ]; then
    echo "REFUSING to skip npm ci: $STAMP does not exist."
    echo "  This tree was installed before the stamp existed, or by something other than this"
    echo "  script, so nothing can vouch for which lockfile produced it. Run once without"
    echo "  FLASHTAP_SKIP_NPM_CI=1 to install and stamp it."
    exit 1
  fi
  INSTALLED_SHA="$(cat "$STAMP")"
  if [ "$INSTALLED_SHA" != "$LOCK_SHA" ]; then
    echo "REFUSING to skip npm ci: package-lock.json has changed since this tree was installed."
    echo "  installed from : $INSTALLED_SHA"
    echo "  lockfile now   : $LOCK_SHA"
    echo "  The dependencies you would build against are not the ones on disk. Re-run without"
    echo "  FLASHTAP_SKIP_NPM_CI=1."
    exit 1
  fi
  echo "  skipped: node_modules was installed from this exact package-lock.json"
  echo "  lockfile sha256: $LOCK_SHA"
else
  echo "=== npm ci ==="
  npm ci --no-audit --no-fund
  # Stamp only AFTER a successful install -- `set -e` means we do not get here otherwise, so the
  # stamp can never describe a tree that was half-written.
  printf '%s\n' "$LOCK_SHA" > "$STAMP"
  echo "  stamped $STAMP with $LOCK_SHA"
fi

# ---------------------------------------------------------------------------
# THE COMMIT SHA, BAKED IN AT BUILD TIME.
#
# /api/version reads process.env.GIT_COMMIT_SHA, and that value is inlined by this build -- not
# supplied at runtime. The CI workflow sets it on this step (GIT_COMMIT_SHA: ${{ github.sha }});
# the local path never did, so every locally-built version answered {"commit":null} and there was
# no way to tell what production was running. Measured 2026-09-04 against a 0%-traffic preview.
#
# Resolved from the caller's environment first, because git usually CANNOT run in here: this repo
# is a git WORKTREE, so /app/.git is a pointer file holding a Windows path to a gitdir outside the
# mount. The deploy wrapper passes GIT_COMMIT_SHA in; the `git rev-parse` below is the fallback for
# a normal checkout or a container with the gitdir mounted.
#
# NOT DEFAULTED TO A PLACEHOLDER. An artifact that cannot say which commit it is must not be built,
# because the only thing worse than no answer from /api/version is a confident wrong one.
# ---------------------------------------------------------------------------
if [ -z "${GIT_COMMIT_SHA:-}" ]; then
  GIT_COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
fi
case "$GIT_COMMIT_SHA" in
  [0-9a-f]*) : ;;
  *) GIT_COMMIT_SHA="" ;;
esac
if [ -z "$GIT_COMMIT_SHA" ]; then
  echo "REFUSING: no GIT_COMMIT_SHA and git cannot resolve one here."
  echo "  Pass it in:  docker run -e GIT_COMMIT_SHA=\$(git rev-parse HEAD) ..."
  echo "  A build that cannot identify itself becomes a production version answering"
  echo "  {\"commit\":null} on /api/version, which is how a deploy silently ships anything."
  exit 1
fi
export GIT_COMMIT_SHA
export NEXT_PUBLIC_COMMIT_SHA="$GIT_COMMIT_SHA"
echo "  commit: $GIT_COMMIT_SHA"

echo "=== opennext build ==="
npx @opennextjs/cloudflare@1.20.1 build

# The value actually baked in, read back out of the artifact rather than trusted from the shell.
echo "=== which Supabase project is in the client bundle? ==="
grep -rhoE "https://[a-z]{20}\.supabase\.co" .open-next/assets/_next/static 2>/dev/null | sort -u | sed 's/^/  /' || true

echo "=== artifact check (the gate) ==="
node /app/scripts/deploy/check-opennext-artifact.mjs /app/.open-next

echo
echo "Artifact is good. NOT uploaded and NOT promoted by this script — that is deliberate."
echo "Next: scripts/deploy/upload-preview.sh, then smoke, then an explicit promotion."
