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

echo "=== npm ci ==="
npm ci --no-audit --no-fund

echo "=== opennext build ==="
npx @opennextjs/cloudflare@1.20.1 build

echo "=== artifact check (the gate) ==="
node /app/scripts/deploy/check-opennext-artifact.mjs /app/.open-next

echo
echo "Artifact is good. NOT uploaded and NOT promoted by this script — that is deliberate."
echo "Next: scripts/deploy/upload-preview.sh, then smoke, then an explicit promotion."
