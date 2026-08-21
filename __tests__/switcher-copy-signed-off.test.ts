import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * THE RESTAURANT SWITCHER'S FIVE STRINGS ARE SIGNED OFF, AND THEY REACHED PRODUCTION UNSIGNED.
 *
 * The owner of a multi-location account read `PENDING COPY — Location` above this control on all
 * twenty screens in the `app/(staff)` layout. Signed off 2026-08-21; the wording below is the
 * owner's, verbatim.
 *
 * WHY A SOURCE ASSERTION, and the same reasoning as order-alert-copy-signed-off.test.ts: the five
 * strings live in one constant and are read from it at seven call sites. The thing worth pinning is
 * the constant. Mounting the sidebar to read them back would need auth, a Supabase session and a
 * multi-restaurant account, to assert five string literals.
 *
 * THIS IS NOT THE MARKER CHECK. `scripts/check-no-pending-copy.mjs` is the class gate that fails the
 * production deploy on ANY placeholder anywhere, and it exists precisely because four per-string
 * pins like this one could not catch a sixth string in a new file. This file does the other half:
 * it pins THESE words, so a later edit cannot quietly reword copy a human signed.
 */
export {} // module scope

const SRC = readFileSync(
  join(process.cwd(), 'components/dashboard/restaurant-switcher.tsx'),
  'utf8',
)

// Comments stripped: the docblock above the constant legitimately quotes the old placeholder and
// explains the convention. A grep that matches its own explanation is the trap the tab back-button
// test hit, and the one check-no-pending-copy.mjs strips for the same reason.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

describe('the restaurant switcher copy', () => {
  it('carries no PENDING COPY marker', () => {
    expect(CODE).not.toMatch(/PENDING COPY/)
  })

  it.each([
    ['label', 'Location'],
    ['placeholder', 'Choose a location'],
    ['switching', 'Switching…'],
    ['failedTitle', 'Could not switch location'],
    ['failedBody', 'You are still on your previous location.'],
  ])('%s reads "%s"', (key, text) => {
    // Plain containment of the whole `key: 'value'` pair, not a loose search for the words --
    // a value that drifted onto the wrong key would otherwise still pass.
    expect(CODE).toContain(`${key}: '${text}'`)
  })

  it('uses a real ellipsis in `switching`, not three dots', () => {
    // Signed with U+2026 to match the existing house style. Three periods is a different string and
    // renders differently at 10px.
    expect(CODE).toContain('Switching…')
    expect(CODE).not.toContain('Switching...')
  })

  it('says "location" throughout and never "restaurant" in the copy', () => {
    // The label is `Location`, so the siblings have to agree: a control labelled one thing that
    // fails in the vocabulary of another reads as two different features. Asserted on the copy
    // constant alone -- the surrounding code is full of `restaurantId`, which is correct.
    const block = CODE.slice(CODE.indexOf('const SWITCHER_COPY = {'))
    const copyObject = block.slice(0, block.indexOf('} as const'))
    expect(copyObject).not.toMatch(/restaurant/i)
    expect(copyObject).toMatch(/location/i)
  })

  it('does not invite a retry in the fallback body', () => {
    // Ruled: `failedBody` is shown only when the server gave no reason of its own, so we do not
    // know the failure is transient. "Try again" would be a promise we cannot support, and is how a
    // retry loop starts. It states the outcome instead.
    expect(CODE).not.toMatch(/failedBody:[^\n]*[Tt]ry again/)
  })
})
