/**
 * #334 — build the key→text map from the PRE-MOVE files, not from the post-move ones.
 *
 * The pin test's whole value is that its expected values come from the original literals. Deriving
 * them from the copy module I just wrote would be circular: it would assert that the strings I moved
 * equal the strings I moved. So this reconstructs the screens as they were at a given ref, runs the
 * same detector over them, and emits the map from that.
 *
 * Usage:  node scripts/build-menu-copy-pins.mjs <ref>     (default HEAD)
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'

const REF = process.argv[2] || 'HEAD'
const TMP = join(process.cwd(), '.menu-copy-baseline')

const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'at', 'in', 'on', 'is', 'be'])
function keyFor(text) {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const meaningful = words.filter((w) => !STOPWORDS.has(w))
  const chosen = (meaningful.length >= 2 ? meaningful : words).slice(0, 5)
  if (chosen.length === 0) return 'copy'
  return chosen.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('')
}

rmSync(TMP, { recursive: true, force: true })

const files = execFileSync('git', ['ls-tree', '-r', '--name-only', REF, 'app/menu'], { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s.endsWith('.tsx') || s.endsWith('.ts'))

for (const f of files) {
  const content = execFileSync('git', ['show', `${REF}:${f}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const dest = join(TMP, f)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content)
}

const hits = JSON.parse(
  execFileSync('node', ['scripts/check-menu-copy-sourced.mjs', '--json', `--root=${TMP}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
)

const uniqueTexts = [...new Set(hits.map((h) => h.text))].sort()
const used = new Map()
const map = {}
for (const text of uniqueTexts) {
  const base = keyFor(text)
  const n = used.get(base) ?? 0
  used.set(base, n + 1)
  map[n === 0 ? base : `${base}${n + 1}`] = text
}

const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync('scripts/.menu-copy-pins.json', JSON.stringify(sorted, null, 2))

// Where each key came from, so a reviewer can find any string's original home.
const origin = {}
for (const h of hits) {
  const key = Object.keys(map).find((k) => map[k] === h.text)
  if (!origin[key]) origin[key] = []
  origin[key].push(`${h.file}:${h.line}`)
}
writeFileSync('scripts/.menu-copy-origins.json', JSON.stringify(origin, null, 2))

rmSync(TMP, { recursive: true, force: true })
console.log(`${Object.keys(sorted).length} key(s) from ${files.length} file(s) at ${REF}`)
console.log(`${hits.length} call site(s)`)
