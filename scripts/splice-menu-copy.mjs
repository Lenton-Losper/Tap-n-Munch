/**
 * #334 — splice the moved keys into lib/customer-copy/menu-copy.ts and regenerate the pin block.
 * ONE-OFF, run once per move.
 *
 * Values come from scripts/.menu-copy-pins.json, which build-menu-copy-pins.mjs derives from the
 * PRE-MOVE files. Nothing here retypes a string, so nothing here can quietly reword one.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const pins = JSON.parse(readFileSync('scripts/.menu-copy-pins.json', 'utf8'))
const origins = JSON.parse(readFileSync('scripts/.menu-copy-origins.json', 'utf8'))
const MODULE = 'lib/customer-copy/menu-copy.ts'

const src = readFileSync(MODULE, 'utf8')
const existingKeys = new Set([...src.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]))

const screenOf = (key) => {
  const sites = origins[key] || []
  const files = [...new Set(sites.map((s) => s.replace(/:\d+$/, '')))]
  if (files.length > 1) return 'shared'
  return files[0]
    .replace('app/menu/[restaurantId]/', '')
    .replace('app/menu/', '')
    .replace('/page.tsx', '')
    .replace('page.tsx', 'menu root')
}

const grouped = new Map()
for (const key of Object.keys(pins)) {
  if (existingKeys.has(key)) continue
  const g = screenOf(key)
  if (!grouped.has(g)) grouped.set(g, [])
  grouped.get(g).push(key)
}

const q = (s) => JSON.stringify(s)

let block = ''
for (const [screen, keys] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  block += `\n  // ---------------------------------------------------------------- ${screen}\n`
  for (const key of keys.sort()) {
    const sites = (origins[key] || []).length
    block += sites > 1 ? `  /** Used at ${sites} sites. */\n` : ''
    block += `  ${key}: ${q(pins[key])},\n`
  }
}

// Matched by regex, not by a literal with \n in it: this repo checks out CRLF on Windows and LF in
// CI, and a hard-coded newline made the splice work in one and fail in the other.
const markerRe = /\} as const\r?\n\r?\n\/\*\*\r?\n \* NOT COPY\./
const markerMatch = src.match(markerRe)
if (!markerMatch) throw new Error('could not find the end of MENU_COPY')
const marker = markerMatch[0]

const header = `
  // ================================================================================================
  // MOVED FROM app/menu/** BY #334, 2026-08-24. NOT REWRITTEN.
  //
  // Every value below is byte-identical to the literal it replaced, and
  // __tests__/menu-copy-move-changed-nothing.test.ts pins each one to that literal. Keys are slugs
  // of the text itself, so a key cannot be attached to the wrong sentence by construction -- which
  // matters, because a swapped key passes both the gate and the pin test and would be read by
  // customers forever. Two screens showing the same sentence share one key; splitting them is a
  // copy decision, not a refactor.
  //
  // These have NOT been through wording sign-off -- they were already live. Moving them makes them
  // visible to the owner and to the gate, which is the whole point of #334.
  // ================================================================================================
`

writeFileSync(MODULE, src.replace(marker, header + block + marker))
console.log(`spliced ${[...grouped.values()].flat().length} key(s) into ${MODULE}`)

// ---- the pin block for the test
let pinBlock = ''
for (const [screen, keys] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  pinBlock += `    // ---- ${screen}\n`
  for (const key of keys.sort()) pinBlock += `    ${key}: ${q(pins[key])},\n`
}
writeFileSync('scripts/.menu-copy-pin-block.txt', pinBlock)
console.log('pin block written to scripts/.menu-copy-pin-block.txt')
