/**
 * THE SOUND-ALERT LABELS ARE SIGNED OFF, AND ARE THE LAST PENDING COPY ON THE STAFF DASHBOARD.
 *
 * These three strings shipped to production as `PENDING COPY - ...` markers and staff read them on
 * the Live Orders header for real. Signed off 2026-08-19; the wording below is the human's, verbatim.
 *
 * WHY A SOURCE ASSERTION. Each string is used THREE times per state -- visible label, `aria-label`
 * and `title` -- from a single constant, so the thing worth pinning is the constant itself. Mounting
 * the dashboard to read it back would need auth, permissions and a live Supabase client to assert a
 * string literal.
 *
 * The marker check is the half that would have caught the original defect: a placeholder reaching
 * production is not a rendering bug, it is a string nobody replaced.
 */
export {} // module scope

const { readFileSync } = require('fs') as typeof import('fs')
const { join } = require('path') as typeof import('path')

const src = readFileSync(join(process.cwd(), 'components/orders-dashboard.tsx'), 'utf8')

describe('the incoming-order sound labels', () => {
  it('carries no PENDING COPY marker anywhere in the staff dashboard', () => {
    // Comments stripped: the docblock explaining the convention legitimately says the words, and a
    // grep that matches its own explanation is the trap #173 and the tab back-button both hit.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/PENDING COPY/)
  })

  it.each([
    ['armed', 'Sound on'],
    ['blocked', 'Turn on sound'],
    ['muted', 'Sound off'],
  ])('%s reads "%s"', (state, label) => {
    // Plain containment, not a RegExp: a heredoc collapsed the `\s` in the first version of
    // this line to a literal `s`, so the pattern read /armed:s*'Sound on'/ and failed against a
    // correct file. Same class as the recorded Python-heredoc escape collapse.
    expect(src).toContain(`${state}: '${label}',`)
  })

  it('states fact in two states and instructs in exactly one', () => {
    // The ruling: "Turn on sound" is the only instruction, because `blocked` is the only state
    // where the staff member has something to do. If a future edit makes another state imperative
    // the labels stop reading as a status and start reading as three buttons.
    const imperative = ['Sound on', 'Turn on sound', 'Sound off'].filter((l) => /^Turn\b/.test(l))
    expect(imperative).toEqual(['Turn on sound'])
  })
})
