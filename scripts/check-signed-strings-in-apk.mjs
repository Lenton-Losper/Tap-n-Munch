/**
 * IS EVERY SIGNED STRING ACTUALLY IN THE APK?
 *
 * ================================================================================================
 * WHY A PLAIN GREP GETS THIS WRONG
 * ================================================================================================
 *
 * A release bundle is HERMES BYTECODE (facebook::hermes v98), not JavaScript, and Hermes stores
 * strings in TWO tables:
 *
 *   - a pure-ASCII string goes in an 8-bit table, byte-per-character. UTF-8 grep finds it.
 *   - a string containing ANY non-ASCII character -- an em dash, a curly apostrophe, an ellipsis --
 *     goes in a UTF-16 table, two bytes per character, little-endian. UTF-8 grep finds NOTHING.
 *
 * On 2026-09-05 this cost a build: two signed strings were reported MISSING from the 128 bundle
 * and both were present, in UTF-16, because the copy uses em dashes. The report was wrong, not the
 * build. House copy style produces non-ASCII punctuation on almost every sentence that matters, so
 * the strings most likely to be misreported are exactly the ones doing the most work.
 *
 * SO EVERY STRING IS SEARCHED IN BOTH ENCODINGS and a hit in either counts. A string found in
 * neither is genuinely absent.
 *
 * ================================================================================================
 * IT ALSO CHECKS THAT IT CAN FIND ANYTHING AT ALL
 * ================================================================================================
 *
 * "All clear" is the cheapest thing in the world for a broken checker to say -- point it at the
 * wrong file, or at a bundle it failed to extract, and every string is "missing", or worse, the
 * comparison is empty and everything trivially passes. So:
 *
 *   - a NEGATIVE control: a string that must NOT be in any bundle. If it is "found", the search is
 *     matching things it should not and every positive result is worthless.
 *   - a POSITIVE control per encoding: a known-ASCII and a known-non-ASCII string from the signed
 *     set. If the UTF-16 control is not found, the UTF-16 path is broken and any "missing" verdict
 *     on a non-ASCII string is unproven rather than true.
 *
 * Usage:
 *   node scripts/check-signed-strings-in-apk.mjs <path-to.apk>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const apkPath = process.argv[2]
if (!apkPath) {
  console.error('usage: node scripts/check-signed-strings-in-apk.mjs <path-to.apk>')
  process.exit(2)
}
if (!existsSync(apkPath)) {
  console.error(`no such file: ${apkPath}`)
  process.exit(2)
}

/** Every signed copy module whose strings must reach the device. */
const COPY_MODULES = [
  'src/constants/splitCardCopy.ts',
  'src/constants/roundItemSheetCopy.ts',
  'src/constants/takePaymentCopy.ts',
]

/**
 * Strings that are exported but deliberately render NOWHERE. They are kept for auditability of the
 * signature, not for display, so their absence from the UI is the point -- but they are still
 * compiled into the bundle as module exports, so they are checked like any other.
 */
const RETIRED = new Set(['TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER'])

/** Must NOT be in any bundle. If this is "found", the search is broken, not the build. */
const NEGATIVE_CONTROL = 'zzz-this-string-is-in-no-bundle-anywhere-9f2a'

/**
 * THE SOURCE FORM IS NOT THE RUNTIME FORM, and the search must use the runtime form.
 *
 * A signed string containing an apostrophe is written either double-quoted ("This table's
 * bill") or single-quoted with an escape. Both produce the SAME runtime string, and it is the
 * runtime string that ends up in the bundle -- so a non-greedy match to the next quote would
 * stop dead at an escape, hand back a truncated fragment, and then report the string as MISSING
 * because the fragment was not found.
 *
 * That is the same class of false negative as the Hermes UTF-16 one this whole script exists
 * for: an instrument reporting absence because it looked for the wrong bytes.
 */
function unescapeJs(text) {
  return text.replace(/\\([\'\"\\nrt])/g, (_, c) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
  )
}

function extractStringLiterals(file) {
  const src = readFileSync(file, 'utf8')
  const out = []
  // Either quote style, escapes honoured so the delimiter search cannot end early.
  const re =
    /export const ([A-Z0-9_]+)\s*=\s*(?:\r?\n\s*)?(['"])((?:\\.|(?!\2)[\s\S])*)\2\s*;/g
  let m
  while ((m = re.exec(src))) {
    out.push({ name: m[1], text: unescapeJs(m[3]), file })
  }
  return out
}

function findBundle(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      const hit = findBundle(full)
      if (hit) return hit
    } else if (name === 'index.android.bundle') {
      return full
    }
  }
  return null
}

// ---------------------------------------------------------------- extract
const work = mkdtempSync(join(tmpdir(), 'apkcheck-'))
try {
  execFileSync('unzip', ['-o', '-q', apkPath, 'assets/*', '-d', work], { stdio: 'pipe' })
} catch {
  // unzip returns non-zero when some members are skipped; the bundle check below is the real test.
}
const bundlePath = findBundle(work)
if (!bundlePath) {
  console.error('REFUSING: no index.android.bundle inside the APK. Nothing was checked.')
  process.exit(1)
}
const bundle = readFileSync(bundlePath)

const magic = bundle.subarray(0, 8)
const isHermes = magic.toString('hex').startsWith('c61fbc03c103191f')
console.log('='.repeat(78))
console.log('SIGNED STRINGS IN THE PACKAGED BUNDLE')
console.log('='.repeat(78))
console.log(`  apk    : ${apkPath}`)
console.log(`  bundle : ${bundlePath.slice(work.length + 1)}  (${bundle.length} bytes)`)
console.log(`  format : ${isHermes ? 'Hermes bytecode' : 'plain JavaScript'}`)
console.log('')

// ---------------------------------------------------------------- search
const asciiHay = bundle
const utf16Hay = bundle

function foundAscii(text) {
  return asciiHay.includes(Buffer.from(text, 'utf8'))
}
function foundUtf16(text) {
  return utf16Hay.includes(Buffer.from(text, 'utf16le'))
}

const strings = COPY_MODULES.flatMap((f) => (existsSync(f) ? extractStringLiterals(f) : []))
if (strings.length === 0) {
  console.error('REFUSING: no signed strings were extracted. The checker found nothing to check.')
  process.exit(1)
}

const results = strings.map((s) => {
  const nonAscii = /[^\x00-\x7F]/.test(s.text)
  const a = foundAscii(s.text)
  const u = foundUtf16(s.text)
  return { ...s, nonAscii, ascii: a, utf16: u, present: a || u }
})

// ---------------------------------------------------------------- controls
const negFound = foundAscii(NEGATIVE_CONTROL) || foundUtf16(NEGATIVE_CONTROL)
const asciiControl = results.find((r) => !r.nonAscii && r.present)
const utf16Control = results.find((r) => r.nonAscii && r.present)
const anyNonAscii = results.some((r) => r.nonAscii)

console.log('CONTROLS')
console.log(`  negative (must be absent)      : ${negFound ? 'FOUND — SEARCH IS BROKEN' : 'absent, good'}`)
console.log(`  ascii path proven by           : ${asciiControl ? asciiControl.name : 'NONE — unproven'}`)
console.log(
  `  utf-16 path proven by          : ${
    utf16Control ? utf16Control.name : anyNonAscii ? 'NONE — unproven' : 'n/a, no non-ascii strings'
  }`,
)
console.log('')

// ---------------------------------------------------------------- report
let missing = 0
for (const mod of COPY_MODULES) {
  const rows = results.filter((r) => r.file === mod)
  if (rows.length === 0) continue
  console.log(`${mod}  (${rows.length})`)
  for (const r of rows) {
    const where = r.ascii ? 'ascii' : r.utf16 ? 'utf-16' : '—'
    const flag = r.present ? 'ok    ' : 'MISSING'
    if (!r.present) missing += 1
    const note = RETIRED.has(r.name) ? '  [retired: exported, renders nowhere]' : ''
    console.log(`  ${flag}  ${where.padEnd(7)} ${r.name}${note}`)
  }
  console.log('')
}

const controlsBad =
  negFound || !asciiControl || (anyNonAscii && !utf16Control)

console.log('='.repeat(78))
console.log(`  ${results.length} signed strings, ${missing} missing`)
if (controlsBad) {
  console.log('  CONTROLS FAILED — this run proves nothing either way.')
  process.exit(1)
}
if (missing > 0) {
  console.log('  FAIL: strings are genuinely absent from the packaged bundle.')
  process.exit(1)
}
console.log('  PASS: every signed string is in the bundle the device will run.')
