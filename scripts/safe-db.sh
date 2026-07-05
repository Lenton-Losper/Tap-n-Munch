#!/usr/bin/env bash
# Thin wrapper — see CONTRIBUTING.md and scripts/safe-supabase-linked.ts
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx scripts/safe-supabase-linked.ts "$@"
