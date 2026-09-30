/**
 * MUTATION CHECK for the menu editor's price boxes (variant + add-on), 2026-09-30.
 *
 * Each mutation reintroduces ONE way the controlled-input fix could regress, prints the mutated
 * line back from disk, runs the two regression suites and requires them RED with a real test
 * count (a compile fault is an instrument fault, never a pass). The file is restored whatever
 * happens, and the suites then run unmutated and must be GREEN.
 *
 * PI-1 is the original defect itself: `Number(value) || 0`, which turned a cleared box back into 0.
 *
 *   node scripts/mutate-price-inputs.mjs          # all
 *   node scripts/mutate-price-inputs.mjs PI-1     # one
 *
 * No main-module guard on purpose: on Windows the file:// comparison never matches and the script
 * would exit 0 having run nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js')
const FILE = 'components/menu/menu-item-form-modal.tsx'
const VARIANT = '__tests__/menu-editor-variant-price-input.test.tsx'
const ADDON = '__tests__/menu-editor-addon-price-input.test.tsx'

const MUTATIONS = [
  {
    id: 'PI-1',
    what: 'the original defect: an emptied price box becomes 0 again (`Number(value) || 0`)',
    from: "  return value.trim() === '' ? null : Number(value)\n",
    to: '  return Number(value) || 0\n',
    suites: [VARIANT, ADDON],
  },
  {
    id: 'PI-2',
    what: 'focusing a price box no longer selects its value',
    from: '  event.currentTarget.select()\n',
    to: '  void event\n',
    suites: [VARIANT, ADDON],
  },
  {
    id: 'PI-3',
    what: 'a negative final price is accepted on save',
    from: '  return typeof price === \'number\' && Number.isFinite(price) && price >= 0\n',
    to: "  return typeof price === 'number' && Number.isFinite(price)\n",
    suites: [VARIANT, ADDON],
  },
  {
    id: 'PI-4',
    what: 'variant prices are not validated on save (an empty named variant is dropped silently)',
    from: '      .filter((variant) => !isValidPrice(variant.price))\n',
    to: '      .filter(() => false)\n',
    suites: [VARIANT],
  },
  {
    id: 'PI-5',
    what: 'add-on prices are not validated on save (an empty price is written as null)',
    from: '          .filter((addon) => !isValidPrice(addon.price))\n',
    to: '          .filter(() => false)\n',
    suites: [ADDON],
  },
  {
    id: 'PI-6',
    what: 'an entirely blank add-on row is written to the item',
    from: "  return addons.filter((addon) => addon.name.trim() !== '' || addon.price !== null)\n",
    to: '  return addons\n',
    suites: [ADDON],
  },
  {
    id: 'PI-7',
    what: 'the variant price box loses min="0"',
    from: '                        placeholder="25.00"\n                        min="0"\n',
    to: '                        placeholder="25.00"\n',
    marker: '                        value={priceForInput(variant.price)}',
    suites: [VARIANT],
  },
  {
    id: 'PI-8',
    what: 'the add-on price box loses min="0"',
    from: '                        placeholder="Price"\n                        min="0"\n',
    to: '                        placeholder="Price"\n',
    marker: '                        value={priceForInput(addon.price)}',
    suites: [ADDON],
  },
]

function runJest(suites) {
  const r = spawnSync(process.execPath, [JEST, '--forceExit', '--maxWorkers=2', ...suites], { cwd: ROOT, encoding: 'utf8' })
  const out = `${r.stdout}\n${r.stderr}`
  const tests = /Tests:\s+([^\n]+)/.exec(out)
  const firstRed = /●\s+([^\n]+›[^\n]+)/.exec(out)
  return {
    status: r.status,
    summary: tests ? tests[1].trim() : '(no Tests: line)',
    firstRed: firstRed ? firstRed[1].trim() : null,
    compileFault: /Test suite failed to run/.test(out),
  }
}

const only = process.argv[2]
const chosen = MUTATIONS.filter((m) => !only || m.id === only)
if (chosen.length === 0) {
  console.error(`no mutation named ${only}`)
  process.exit(2)
}

const path = join(ROOT, FILE)
const original = readFileSync(path, 'utf8')
const crlf = original.includes('\r\n')
const lf = crlf ? original.replace(/\r\n/g, '\n') : original

let failures = 0
try {
  for (const m of chosen) {
    const hits = lf.split(m.from).length - 1
    if (hits !== 1) {
      console.error(`${m.id}: expected exactly one match in ${FILE}, found ${hits}`)
      failures++
      continue
    }
    const mutated = lf.replace(m.from, m.to)
    writeFileSync(path, crlf ? mutated.replace(/\n/g, '\r\n') : mutated)
    const onDisk = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    if (onDisk === lf) throw new Error(`${m.id}: mutation did not land`)
    const shown = m.marker ?? m.to
    const at = onDisk.slice(0, onDisk.indexOf(shown)).split('\n').length
    console.log(`\n${m.id}: ${m.what}\n  ${FILE}:${at} now reads:\n    ${shown.trimEnd().split('\n').join('\n    ')}`)
    const r = runJest(m.suites)
    const red = r.status !== 0 && !r.compileFault && /failed/.test(r.summary)
    console.log(`  -> ${red ? 'RED (caught)' : r.compileFault ? 'INSTRUMENT FAULT (compile)' : 'GREEN (NOT CAUGHT)'}  Tests: ${r.summary}`)
    if (r.firstRed) console.log(`     first RED: ${r.firstRed}`)
    if (!red) failures++
    writeFileSync(path, original)
  }
} finally {
  writeFileSync(path, original)
}
if (readFileSync(path, 'utf8') !== original) {
  console.error(`RESTORE FAILED: ${FILE}`)
  process.exit(3)
}

const control = runJest([VARIANT, ADDON])
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED'}  Tests: ${control.summary}`)
if (control.status !== 0) failures++
process.exit(failures === 0 ? 0 : 1)
