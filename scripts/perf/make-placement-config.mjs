/**
 * PHASE 1 (perf/latency-sprint, 2026-10-01): writes a STAGING-ONLY wrangler config with a
 * [placement] block, derived from wrangler.toml at run time so it can never drift from it.
 *
 *   node scripts/perf/make-placement-config.mjs smart    # Smart Placement (wrangler 3.99 accepts it)
 *   node scripts/perf/make-placement-config.mjs region   # region = "aws:eu-west-1" (needs wrangler 4.x)
 *
 * Output: wrangler.staging.placement-<variant>.toml (untracked; see .gitignore). Deploying it is a
 * separate, deliberate step -- see docs/perf/placement-experiment.md. This script deploys nothing.
 *
 * REFUSES unless the source config is the staging worker. Production placement is a recorded
 * decision for a human: docs/perf/placement-experiment.md, section "Production change (NOT applied)".
 *
 * No main-module guard on purpose: on Windows the file:// comparison never matches and the script
 * would exit 0 having run nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = join(ROOT, 'wrangler.toml')
// Supabase: AWS eu-west-1 (Ireland). Cloudflare's documented placement-hint format is provider:region.
const DB_REGION = 'aws:eu-west-1'

const variant = process.argv[2]
const blocks = {
  smart: '[placement]\nmode = "smart"\n',
  region: `[placement]\nregion = "${DB_REGION}"\n`,
}
if (!blocks[variant]) {
  console.error('usage: make-placement-config.mjs smart|region')
  process.exit(2)
}

const src = readFileSync(SOURCE, 'utf8')
const name = /^name\s*=\s*"([^"]+)"/m.exec(src)?.[1]
if (name !== 'flashtap-staging') {
  console.error(`refusing: ${SOURCE} names worker "${name}", not flashtap-staging`)
  process.exit(3)
}
if (/^\[placement\]/m.test(src)) {
  console.error('refusing: wrangler.toml already has a [placement] block')
  process.exit(3)
}

// [placement] is a top-level table: it must precede the first [[array-of-tables]] / [table] that
// would otherwise swallow it. Insert it right after the top-level keys (before the first header).
const firstHeader = src.search(/^\[/m)
const out =
  src.slice(0, firstHeader) +
  `# perf/latency-sprint ${new Date().toISOString().slice(0, 10)}: placement experiment, STAGING ONLY.\n` +
  blocks[variant] +
  '\n' +
  src.slice(firstHeader)

const target = join(ROOT, `wrangler.staging.placement-${variant}.toml`)
writeFileSync(target, out)
console.log(`wrote ${target}`)
console.log(`  worker: ${name}`)
console.log(`  ${blocks[variant].trim().replace(/\n/g, ' ')}`)
if (variant === 'region') console.log('  NOTE: `region` is rejected by wrangler 3.99 config validation; deploy with wrangler 4.x.')
