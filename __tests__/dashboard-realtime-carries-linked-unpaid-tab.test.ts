/**
 * A REALTIME `tabs` EVENT MUST NOT ERASE THE UNPAID-TAB-ELSEWHERE POINTER.
 *
 * THE DEFECT. `loadTabs` is the only place `linked_unpaid_tab_id` (#211 follow-up) ever entered
 * `tabInfoById`. The `tabs` realtime handler then REPLACED that entry wholesale from the payload
 * and did not carry the pointer across — it carried `members` and stopped there. So the amber
 * "unpaid tab elsewhere" badge vanished from every order on that tab the moment any `tabs` row
 * changed, and the change that matters most is the customer moving to `ready_to_pay`: the badge
 * disappeared at precisely the moment staff were being asked to take payment. Nothing refilled it
 * — `unpaidTabElsewhere` is resolved in `loadTabs`'s second pass and no realtime event re-runs it.
 *
 * WHY IT SURVIVED. `components/orders-dashboard.tsx` carried `@ts-nocheck`, so the TS2345 that
 * describes this exactly — "Property 'linked_unpaid_tab_id' is missing" — was never reported. It
 * was one of the 22 errors found when the pragma came off, and the only one of them that was a
 * real bug rather than a typing gap. No test covered the flag at all.
 *
 * WHY THIS TEST AND NOT JUST `tsc`. The file is typed now, so DELETING the property is a compile
 * error and the compiler is the better guard for that shape. It is not a guard for the other
 * shape: `linked_unpaid_tab_id: null` typechecks perfectly and reintroduces the defect in full.
 * That is what this asserts against.
 *
 * SOURCE ASSERTION, and comments stripped before matching. Mounting `OrdersDashboard` needs
 * `useAuth`, `usePermissions`, a live Supabase client and a router before it renders a node; and
 * the docblock above the fixed line names every symbol asserted below, which is the trap #173 hit.
 */
export {} // module scope

const { readFileSync } = require('fs') as typeof import('fs')
const { join } = require('path') as typeof import('path')

const raw = readFileSync(join(process.cwd(), 'components/orders-dashboard.tsx'), 'utf8')
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * The `tabs` realtime handler only. Asserting against the whole file would pass on `loadTabs`,
 * which has always set the pointer correctly and is not the code under test.
 */
const handlerStart = code.indexOf('`tabs-dash-')
const handler = handlerStart === -1 ? '' : code.slice(handlerStart, handlerStart + 1800)

describe('the tabs realtime handler carries linked_unpaid_tab_id (#211 follow-up)', () => {
  it('locates the handler at all', () => {
    // "Could not check" is not "checked and fine": if the channel name changes, this must fail
    // rather than silently assert against an empty string.
    expect(handlerStart).toBeGreaterThan(-1)
    expect(handler).toMatch(/setTabInfoById\(\(prev\) =>/)
  })

  it('writes linked_unpaid_tab_id into the entry it replaces', () => {
    expect(handler).toMatch(/linked_unpaid_tab_id:/)
  })

  it('does not hardcode the pointer away', () => {
    // The shape `tsc` cannot see. `linked_unpaid_tab_id: null` compiles and erases the flag just as
    // completely as omitting the property did.
    const assignment = /linked_unpaid_tab_id:\s*(null|undefined)\s*,/
    expect(handler).not.toMatch(assignment)
  })

  it('falls back to the previous value when the payload does not carry the column', () => {
    // Correct whether or not the publication ships every column, which is not verifiable from the
    // repository. A stale pointer is harmless by construction: the badge renders only while
    // `unpaidTabElsewhere[linkedId]` still shows that tab unpaid.
    expect(handler).toMatch(/prev\[String\(row\.id\)\]\?\.linked_unpaid_tab_id/)
  })

  it('still reads the pointer where the badge is rendered', () => {
    // The consumer half. A carried value nothing reads would be the same outage in a new place.
    expect(code).toMatch(/tabInfoById\[tabIdOf\(order\)\]\?\.linked_unpaid_tab_id/)
    expect(code).toMatch(/unpaidTabElsewhere\[linkedId\]/)
  })
})

describe('the file is typed, so the compiler guards the omission', () => {
  it('carries no @ts-nocheck', () => {
    // If this ever comes back, the TS2345 that describes this defect stops being reported and the
    // assertions above become the only thing standing between it and production again.
    expect(raw).not.toMatch(/^\s*\/\/\s*@ts-nocheck\b/m)
  })
})
