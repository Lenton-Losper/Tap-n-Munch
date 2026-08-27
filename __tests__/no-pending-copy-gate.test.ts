import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * THE GATE THAT SHOULD HAVE CAUGHT THE SWITCHER, TESTED ON A FIXTURE.
 *
 * `scripts/check-no-pending-copy.mjs` is the class check that four existing per-string assertions
 * could not be: each of those pins one string in one file, so a NEW file with a NEW placeholder was
 * invisible to all of them. That is how `PENDING COPY — Location` reached production and was read by
 * a restaurant owner on twenty staff screens.
 *
 * Asserted against a temp fixture rather than against this repo, because the repo's own answer
 * changes every time a string is signed off — a test pinned to "finds five" would go red the moment
 * the gate did its job.
 *
 * THE FALSE-POSITIVE CASE IS THE ONE THAT DECIDES WHETHER THIS SURVIVES. Roughly ten files
 * legitimately contain the words "PENDING COPY" in prose: the convention's own header, the block
 * comment above the switcher's copy, and the checker itself. A gate that fires on the documentation
 * explaining it would be disabled within a week, so the comment-stripping case below matters as
 * much as the detection case.
 */
const SCRIPT = join(process.cwd(), 'scripts', 'check-no-pending-copy.mjs')

function runGate(root: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, `--root=${root}`], { encoding: 'utf8' })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pendingcopy-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return root
}

describe('the PENDING COPY gate', () => {
  it('FAILS on a placeholder in shippable source', () => {
    const root = fixture({
      'components/thing.tsx': `export const COPY = { label: 'PENDING COPY — Location' }\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(1)
    expect(out).toContain('components/thing.tsx')
    expect(out).toContain('PENDING COPY — Location')
  })

  it('FAILS on the OTHER word order — `COPY PENDING` — which it was blind to until 2026-08-27', () => {
    // THE REAL MISS, not a hypothetical. `lib/payments/verify-payment-outcome.ts` carried three
    // staff-facing placeholders spelled `[COPY PENDING: ...]`. `/PENDING COPY/` does not match
    // that, so this gate reported OK while all three sat on `main`, live on production.
    //
    // Nobody read them — the terminal's `VerifyTerminalPaymentResult` type has no field for the
    // message, so the client discards it — but that is luck, not the gate working. Adding one
    // field to that type puts a placeholder on a payment screen.
    //
    // A checker that recognises exactly one phrasing enforces the phrasing, not the convention.
    const root = fixture({
      'components/thing.tsx': `export const COPY = { label: '[COPY PENDING: staff needs wording here]' }\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(1)
    expect(out).toContain('components/thing.tsx')
    expect(out).toContain('COPY PENDING')
  })

  it('FAILS on the separators a placeholder actually gets written with', () => {
    // `PENDING_COPY` and `pending copy` are the same intent. The gate should not turn on casing
    // or on which punctuation somebody reached for.
    for (const marker of ['PENDING_COPY: label', 'pending copy - label', 'Copy Pending: label']) {
      const root = fixture({ 'components/t.tsx': `export const C = '${marker}'\n` })
      expect(runGate(root).status).toBe(1)
    }
  })

  it('does NOT fire on the two words merely appearing near each other', () => {
    // The widened pattern must still be a MARKER check, not a word-proximity check. "pending" and
    // "copy" are both ordinary English and appear in real code; only the adjacent pair is the
    // convention. Without this, widening the regex would trade a false negative for a false
    // positive and the gate would get switched off.
    const root = fixture({
      'lib/thing.ts': `// returns a copy of every pending order, so the caller can sort it\nexport const pendingOrdersCopy = () => []\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(0)
    expect(out).toContain('OK')
  })

  it('FIRES on the THIRD spelling — [PLACEHOLDER: ...] — which reached a live venue', () => {
    // Found on production 2026-08-27 by the owner, in the menu editor's Inventory tab:
    // `Quantity [PLACEHOLDER: say "per one sold"]`. Four strings across two files, eight renders.
    // The gate matched PENDING COPY / COPY PENDING and had never heard of the word.
    const root = fixture({
      'components/thing.tsx': `export const C = 'Quantity [PLACEHOLDER: say "per one sold"]'
`,
    })
    expect(runGate(root).status).toBe(1)
  })

  it('FIRES on other bracketed marker words, so the next spelling is already covered', () => {
    // The point of the sweep: stop fixing one phrasing at a time. TODO/TBD/FIXME/XXX appear in NO
    // shippable string literal today — this keeps it that way rather than waiting for the fourth.
    for (const marker of ['[TODO: write this]', '[TBD]', '[FIXME: wording]', '[XXX: temp]']) {
      const root = fixture({ 'components/t.tsx': `export const C = '${marker}'
` })
      expect(runGate(root).status).toBe(1)
    }
  })

  it('does NOT fire on lowercase brackets — the two real lines a first cut broke on', () => {
    /**
     * THE DISCRIMINATOR IS CASE, and these are why. A case-insensitive bracket rule fired on:
     *
     *   components/ui/select.tsx          data-[placeholder]:text-muted-foreground
     *   lib/reports/generate-pdf-lib.ts   new Blob([copy], { type: 'application/pdf' })
     *
     * Neither is a marker. Real markers are shouted; lowercase brackets are code. Without this
     * test the next person to "improve" the regex reintroduces both.
     */
    const root = fixture({
      'components/ui/select.tsx':
        `export const cls = "border-input data-[placeholder]:text-muted-foreground"
`,
      'lib/pdf.ts': `export const blob = new Blob([copy], { type: 'application/pdf' })
`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(0)
    expect(out).toContain('OK')
  })

  it('does NOT fire on the sixty-five legitimate lines the marker-word sweep found', () => {
    // Measured across shippable source: PLACEHOLDER 28 (all Tailwind/React props), DRAFT 24 (all
    // `status === 'draft'`), NOT SIGNED 13 (all 'Not signed in'). Matching the WORD rather than
    // the SHAPE would fire on every one of them, and a gate that cries wolf gets switched off.
    const root = fixture({
      'components/form.tsx': `export const a = 'placeholder:text-[#9B978E]'
export const b = 'Search'
`,
      'app/api/doc.ts': `export const c = (status === 'draft')
export const d = 'Only draft invoices can be edited'
`,
      'app/admin/page.tsx': `export const e = 'Not signed in'
`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(0)
    expect(out).toContain('OK')
  })

  it('PASSES once the string is signed off', () => {
    const root = fixture({
      'components/thing.tsx': `export const COPY = { label: 'Location' }\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(0)
    expect(out).toContain('OK')
  })

  it('does NOT fire on prose that explains the convention', () => {
    // The exact shape of every docblock that documents this rule, including the one in the
    // checker's own header and the one above the switcher's copy block.
    const root = fixture({
      'lib/copy.ts':
        `/**\n * Mark unsigned strings PENDING COPY rather than stopping for wording.\n` +
        ` *     git grep "PENDING COPY" -- lib/copy.ts\n */\n` +
        `// PENDING COPY markers are listed at the end.\n` +
        `export const COPY = { label: 'Location' }\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(0)
    expect(out).toContain('OK')
  })

  it('ignores tests, scripts and docs — a marker there is not readable by anyone', () => {
    const root = fixture({
      '__tests__/x.test.ts': `expect(s).not.toMatch(/PENDING COPY/)\n`,
      'components/ok.tsx': `export const COPY = { label: 'Location' }\n`,
    })
    expect(runGate(root).status).toBe(0)
  })

  it('--list reports without failing, so a sign-off list can be produced', () => {
    const root = fixture({
      'components/thing.tsx': `export const COPY = { label: 'PENDING COPY — Location' }\n`,
    })
    const out = execFileSync('node', [SCRIPT, `--root=${root}`, '--list'], { encoding: 'utf8' })
    expect(out).toContain('components/thing.tsx')
    expect(out).toContain('reporting only')
  })

  it('is wired into the PRODUCTION deploy, and deliberately not into staging', () => {
    // Staging is where a placeholder legitimately lives — mark it, build the screen, get the
    // wording signed off, then promote. Wiring this into staging.yml would break the workflow it
    // exists to protect.
    const prod = readFileSync(join(process.cwd(), '.github/workflows/production-worker.yml'), 'utf8')
    expect(prod).toContain('scripts/check-no-pending-copy.mjs')
    const staging = readFileSync(join(process.cwd(), '.github/workflows/staging.yml'), 'utf8')
    expect(staging).not.toContain('scripts/check-no-pending-copy.mjs')
  })
})
