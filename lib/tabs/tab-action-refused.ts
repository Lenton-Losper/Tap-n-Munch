/**
 * A refusal from a tab action, carrying the server's own reason code.
 *
 * WHY A CODE AND NOT THE MESSAGE. `POST /api/tabs` now refuses the 23505 recovery branch three
 * different ways (QRA-02/03), and two of them mean "show the customer the PIN prompt" while the
 * third has no customer-side remedy at all. Branching on prose would tie navigation to copy the
 * human owns and may reword at any time; branching on the code does not.
 *
 * Same shape as OrderEditRefused in lib/guest-orders/client.ts, and for the same reason stated
 * there: the reason matters more than the status, because one status covers several situations
 * that need different things said and done.
 */
export class TabActionRefused extends Error {
  readonly code: string
  readonly httpStatus: number
  /** The tab the refusal is about, when the server named one. Lets a client act without a re-fetch. */
  readonly tabId: string | null

  constructor(message: string, code: string, httpStatus: number, tabId?: unknown) {
    super(message)
    this.name = 'TabActionRefused'
    this.code = String(code || '')
    this.httpStatus = httpStatus
    const id = String(tabId ?? '').trim()
    this.tabId = id || null
  }
}

/**
 * Codes that mean "this customer needs the PIN prompt", as opposed to "there is nothing they can
 * do here".
 *
 * TAB_PIN_REQUIRED  — they supplied no PIN. Open the prompt clean.
 * TAB_PIN_INCORRECT — they supplied a wrong one. Open the prompt carrying the error.
 *
 * TAB_ALREADY_OPEN is deliberately ABSENT: it is returned when the open tab has no PIN at all
 * (#236's territory), so there is no PIN for the customer to enter and prompting for one would
 * be a dead end that looks like an action.
 */
export const TAB_PIN_PROMPT_CODES = ['TAB_PIN_REQUIRED', 'TAB_PIN_INCORRECT'] as const

export function shouldPromptForTabPin(error: unknown): error is TabActionRefused {
  return (
    error instanceof TabActionRefused &&
    (TAB_PIN_PROMPT_CODES as readonly string[]).includes(error.code)
  )
}
