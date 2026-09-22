/**
 * WHICH ROW A DEVICE ACTIVATES INTO — the decision, on its own.
 *
 * The invariant under test: ONE PHYSICAL DEVICE OWNS EXACTLY ONE TERMINAL ROW, GLOBALLY. The two
 * unique indexes that assert it are NOT removed by this change; what changes is that a device
 * presenting an identity it already owns rebinds to its own row instead of colliding with it.
 *
 * The bug this closes: F19 (terminal 2.38) started sending the device's real ANDROID_ID, so the
 * identity occupied `restaurant_terminals_device_id_unique`. Pointing a reinstalled device at a
 * row minted by `generate-code` then tried to write an identity another row held — 23505, for
 * ever, because ANDROID_ID survives reinstall.
 */
import {
  resolveActivationTarget,
  ACTIVATION_REFUSALS,
} from '@/lib/terminals/resolve-activation-target'

const VENUE_A = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5'
const VENUE_B = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const CODE_ROW = { id: 'pending-row', restaurant_id: VENUE_A }

describe('first activation of a NEW device', () => {
  it('activates the row the code named when nobody holds the identity', () => {
    const d = resolveActivationTarget({ codeRow: CODE_ROW, holders: [] })
    expect(d.kind).toBe('activate_code_row')
  })

  it('is unaffected by rows belonging to other devices', () => {
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [],
    })
    expect(d.kind).toBe('activate_code_row')
  })
})

describe('reinstall / re-activation of the SAME device, SAME restaurant', () => {
  it('rebinds to the row the device already owns, and retires the code row', () => {
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [{ id: 'the-devices-own-row', restaurant_id: VENUE_A }],
    })
    expect(d).toEqual({
      kind: 'rebind_existing',
      terminalId: 'the-devices-own-row',
      supersededTerminalId: 'pending-row',
    })
  })

  /**
   * THE TILL KEEPS ITS ID. Every payment, printer config and audit row is attributed to
   * `terminal_id`; activating the new row instead would strand all of it behind a dead id.
   */
  it('never returns the code row as the terminal to activate on a rebind', () => {
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [{ id: 'the-devices-own-row', restaurant_id: VENUE_A }],
    })
    expect(d.kind === 'rebind_existing' && d.terminalId).not.toBe(CODE_ROW.id)
  })

  /**
   * `reissue-code` puts the device's OWN row back into pending, so the row the code names IS the
   * row holding the identity. That path already worked and must keep working: it is a plain
   * activation, not a rebind.
   */
  it('the reissue-code path — the code row IS the holder — stays a normal activation', () => {
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [{ id: CODE_ROW.id, restaurant_id: VENUE_A }],
    })
    expect(d.kind).toBe('activate_code_row')
  })

  it('both unique columns pointing at the same row is one holder, not a conflict', () => {
    // device_id's row and device_serial's row are normally the same row, read twice.
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [
        { id: 'the-devices-own-row', restaurant_id: VENUE_A },
        { id: 'the-devices-own-row', restaurant_id: VENUE_A },
      ],
    })
    expect(d).toEqual({
      kind: 'rebind_existing',
      terminalId: 'the-devices-own-row',
      supersededTerminalId: 'pending-row',
    })
  })
})

describe('the SAME device activating for a DIFFERENT restaurant', () => {
  it('is refused', () => {
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [{ id: 'row-at-other-venue', restaurant_id: VENUE_B }],
    })
    expect(d.kind).toBe('reject_cross_restaurant')
  })

  /**
   * CHECKED BEFORE the same-restaurant case on purpose. A device whose identity is somehow spread
   * across two venues must not have a winner picked silently — that moves a till between
   * businesses.
   */
  it('is refused even when one of the holders IS in this restaurant', () => {
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [
        { id: 'row-here', restaurant_id: VENUE_A },
        { id: 'row-at-other-venue', restaurant_id: VENUE_B },
      ],
    })
    expect(d.kind).toBe('reject_cross_restaurant')
  })

  it('two DIFFERENT rows in the same restaurant are refused rather than guessed between', () => {
    const d = resolveActivationTarget({
      codeRow: CODE_ROW,
      holders: [
        { id: 'row-one', restaurant_id: VENUE_A },
        { id: 'row-two', restaurant_id: VENUE_A },
      ],
    })
    expect(d.kind).toBe('reject_cross_restaurant')
  })
})

describe('a DIFFERENT device using the same activation code', () => {
  it('activates the code row normally — a fresh device holds no identity', () => {
    const d = resolveActivationTarget({ codeRow: CODE_ROW, holders: [] })
    expect(d.kind).toBe('activate_code_row')
  })
})

describe('the refusal copy', () => {
  it('never names a constraint, column, table or row id', () => {
    for (const message of Object.values(ACTIVATION_REFUSALS)) {
      expect(message).not.toMatch(/restaurant_terminals|device_id|device_serial|constraint|23505|unique/i)
    }
  })

  it('tells the operator what to DO', () => {
    expect(ACTIVATION_REFUSALS.cross_restaurant).toMatch(/remove it there/i)
    expect(ACTIVATION_REFUSALS.identity_taken).toMatch(/reissue/i)
  })

  it('the two refusals do not read the same', () => {
    expect(ACTIVATION_REFUSALS.cross_restaurant).not.toBe(ACTIVATION_REFUSALS.identity_taken)
  })
})
