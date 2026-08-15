import {
  TAB_PIN_PROMPT_CODES,
  TabActionRefused,
  shouldPromptForTabPin,
} from '@/lib/tabs/tab-action-refused'

/**
 * The landing branches on these codes to decide whether to open the PIN prompt. Getting the
 * predicate wrong in either direction is a customer-visible dead end:
 *
 *   false negative -> the refusal prints with nothing to press, which is the state this wiring
 *                     exists to remove (#211's shape);
 *   false positive -> a PIN prompt for a tab that has no PIN, which cannot succeed.
 *
 * The route's own copy and codes are asserted live by scripts/probe-qr-exposures-staging.ts
 * (B1 -> TAB_PIN_REQUIRED, B3 -> TAB_PIN_INCORRECT). These bind the CLIENT half.
 */
describe('TabActionRefused', () => {
  it('carries the code, status and tabId the server supplied', () => {
    const err = new TabActionRefused('nope', 'TAB_PIN_REQUIRED', 403, 'tab-1')

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('TabActionRefused')
    expect(err.message).toBe('nope')
    expect(err.code).toBe('TAB_PIN_REQUIRED')
    expect(err.httpStatus).toBe(403)
    expect(err.tabId).toBe('tab-1')
  })

  it('normalises a missing or blank tabId to null rather than an empty string', () => {
    expect(new TabActionRefused('x', 'TAB_PIN_REQUIRED', 403).tabId).toBeNull()
    expect(new TabActionRefused('x', 'TAB_PIN_REQUIRED', 403, '   ').tabId).toBeNull()
  })
})

describe('shouldPromptForTabPin', () => {
  it.each([...TAB_PIN_PROMPT_CODES])('prompts on %s', (code) => {
    expect(shouldPromptForTabPin(new TabActionRefused('m', code, 403, 't'))).toBe(true)
  })

  /**
   * The one that matters most. TAB_ALREADY_OPEN is returned when the open tab has NO PIN
   * (#236's territory), so prompting would ask the customer for something that does not exist.
   * Its copy sends them to staff instead.
   */
  it('does NOT prompt on TAB_ALREADY_OPEN — there is no PIN to enter', () => {
    expect(shouldPromptForTabPin(new TabActionRefused('m', 'TAB_ALREADY_OPEN', 409, 't'))).toBe(false)
  })

  it('does not prompt on an unrelated refusal, a plain Error, or a non-error', () => {
    expect(shouldPromptForTabPin(new TabActionRefused('m', 'TABLE_BLOCKED_BY_CLOSED_TAB', 409))).toBe(false)
    expect(shouldPromptForTabPin(new TabActionRefused('m', '', 500))).toBe(false)
    // A plain Error is what createNewTab threw before this change; if the throw site ever
    // regresses to one, the landing must fall back to the old message rather than prompt.
    expect(shouldPromptForTabPin(new Error('This table already has an open tab.'))).toBe(false)
    expect(shouldPromptForTabPin(null)).toBe(false)
    expect(shouldPromptForTabPin({ code: 'TAB_PIN_REQUIRED' })).toBe(false)
  })
})
