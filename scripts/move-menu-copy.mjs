/**
 * #334 — move inline customer strings under app/menu/** into lib/customer-copy. ONE-OFF.
 *
 * MOVING IS NOT REWRITING. Every string that comes out of a screen goes into the copy module
 * byte-for-byte, and `__tests__/menu-copy-move-changed-nothing.test.ts` pins each one to the literal
 * it replaced. If a value needs to change afterwards, that is a copy decision with a sign-off, made
 * deliberately against a pinned baseline rather than drifting during a refactor.
 *
 * WHY THE KEY IS DERIVED FROM THE TEXT. The real risk in an automated move of this size is not a
 * mangled string — the pin test would catch that. It is a SWAPPED KEY: `MENU_COPY.cartIsEmpty`
 * substituted where `MENU_COPY.orderSummary` belonged. Both the pin test and the gate would still
 * pass, and a customer would read the wrong sentence forever.
 *
 * So the key is a slug of the string's own text. A site containing text T is replaced with the key
 * generated from T, which makes a mismatch impossible by construction rather than by review. Two
 * sites with identical text share one key — they are the same sentence, and splitting them is a
 * copy decision nobody has asked for.
 *
 * Usage:
 *   node scripts/move-menu-copy.mjs --file=app/menu/.../page.tsx   # one screen at a time
 *   node scripts/move-menu-copy.mjs --all --except=cart            # everything but the cart
 *   node scripts/move-menu-copy.mjs --dry                          # show, do not write
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const argOf = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const ONLY_FILE = argOf('file')
const EXCEPT = argOf('except')
const DRY = process.argv.includes('--dry')
const COPY_MODULE = 'lib/customer-copy/menu-copy.ts'

const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'at', 'in', 'on', 'is', 'be'])

function keyFor(text) {
  const words = text
    .toLowerCase()
    // Apostrophes are dropped, not spaced: "hasn't" must slug to `hasnt`, not `hasnT`.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const meaningful = words.filter((w) => !STOPWORDS.has(w))
  const chosen = (meaningful.length >= 2 ? meaningful : words).slice(0, 5)
  if (chosen.length === 0) return 'copy'
  return chosen
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join('')
}

const raw = execFileSync('node', ['scripts/check-menu-copy-sourced.mjs', '--json'], { encoding: 'utf8' })
let hits = JSON.parse(raw)

if (ONLY_FILE) hits = hits.filter((h) => h.file === ONLY_FILE)
if (EXCEPT) hits = hits.filter((h) => !h.file.includes(EXCEPT))

if (hits.length === 0) {
  console.log('nothing to move')
  process.exit(0)
}

/**
 * KEYS COME FROM THE FIXED BASELINE MAP, never from the current scan.
 *
 * The first version derived them from whatever the scan found at that moment, and that is broken the
 * instant this runs more than once: moving the other screens first shrinks the corpus, so a text
 * that collided globally and became `createTab2` no longer collides and becomes `createTab` — a key
 * that already holds a DIFFERENT sentence. Running `--except=cart` and then `--file=cart` did
 * exactly that, and left the cart rendering "Create Tab" where "Create a Tab" belonged, and the
 * wrong QR-code sentence on a money screen. Both would have passed the gate and the pin test.
 *
 * So collision numbering is decided once, over the whole baseline, by build-menu-copy-pins.mjs, and
 * every invocation reads that. A text absent from the map is a hard failure rather than a fresh key,
 * because it means the baseline and the working tree disagree about what exists.
 */
const PINS = JSON.parse(readFileSync('scripts/.menu-copy-pins.json', 'utf8'))
const keyByText = new Map()
for (const [key, text] of Object.entries(PINS)) keyByText.set(text, key)

const unknown = [...new Set(hits.map((h) => h.text))].filter((t) => !keyByText.has(t))
if (unknown.length > 0) {
  console.error('These strings are not in the baseline key map. Re-run build-menu-copy-pins.mjs:')
  for (const t of unknown) console.error('  ' + JSON.stringify(t))
  process.exit(1)
}

const byFile = new Map()
for (const h of hits) {
  if (!byFile.has(h.file)) byFile.set(h.file, [])
  byFile.get(h.file).push(h)
}

const movedKeys = new Map()

for (const [file, rows] of byFile) {
  let source = readFileSync(file, 'utf8')
  // Descending, so an earlier replacement cannot shift a later offset.
  rows.sort((a, b) => b.start - a.start)

  for (const hit of rows) {
    const key = keyByText.get(hit.text)
    movedKeys.set(key, hit.text)
    const original = source.slice(hit.start, hit.end)

    let replacement
    if (hit.kind === 'jsx-text') {
      const lead = original.match(/^\s*/)[0]
      const trail = original.match(/\s*$/)[0]
      replacement = `${lead}{MENU_COPY.${key}}${trail}`
    } else {
      // A JSX attribute needs braces; an ordinary expression position does not.
      const prev = source.slice(0, hit.start).match(/=\s*$/)
      replacement = prev ? `{MENU_COPY.${key}}` : `MENU_COPY.${key}`
    }

    source = source.slice(0, hit.start) + replacement + source.slice(hit.end)
  }

  if (!/from '@\/lib\/customer-copy\/menu-copy'/.test(source)) {
    // The insertion point must be the END of an import STATEMENT, not the last line that happens to
    // begin with `import`. A multi-line `import {` matches that and the new line lands INSIDE the
    // braces, which is a syntax error the codemod cannot see — tsc found it in two files.
    const lines = source.split('\n')
    let insertAt = 0
    let inMultiline = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (inMultiline) {
        if (/^\s*}\s*from\s/.test(line)) {
          inMultiline = false
          insertAt = i + 1
        }
        continue
      }
      if (/^import\s.*\bfrom\s/.test(line) || /^import\s+['"]/.test(line)) insertAt = i + 1
      else if (/^import\s*\{[^}]*$/.test(line)) inMultiline = true
      else if (/^\s*['"]use (client|server)['"]/.test(line) && insertAt === 0) insertAt = i + 1
    }
    lines.splice(insertAt, 0, "import { MENU_COPY } from '@/lib/customer-copy/menu-copy'")
    source = lines.join('\n')
  }

  if (DRY) console.log(`[dry] ${file}: ${rows.length} replacement(s)`)
  else {
    writeFileSync(file, source)
    console.log(`${file}: ${rows.length} moved`)
  }
}

console.log(`\n${movedKeys.size} distinct key(s) needed:`)
const sorted = [...movedKeys.entries()].sort(([a], [b]) => a.localeCompare(b))
for (const [k, v] of sorted) console.log(`  ${k}: ${JSON.stringify(v)},`)

if (!DRY) {
  writeFileSync(
    'scripts/.menu-copy-pending.json',
    JSON.stringify(Object.fromEntries(sorted), null, 2),
  )
  console.log(`\nkeys written to scripts/.menu-copy-pending.json for splicing into ${COPY_MODULE}`)
}
