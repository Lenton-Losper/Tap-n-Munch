/**
 * Sprint 2026-09-28 (C6). Which terminal requests get STRICT variant enforcement.
 *
 * Strict enforcement refuses a line whose required variant group is unanswered. A P5 still on
 * 2.39 has no variant picker and never sends a selection, so turning strict on for everyone would
 * make every item with a required group (including every legacy-`variants` item, which
 * getVariantGroups turns into a required 'Size' group) unsellable from those tills the moment the
 * web deploys. So strictness is a capability the TERMINAL declares: a build that sends
 * `X-FlashTap-Variant-Protocol: 1` has the picker and gets refusals; anything else is priced
 * exactly as before, with the gap logged so it can be measured.
 */
export const VARIANT_PROTOCOL_HEADER = 'x-flashtap-variant-protocol'

export function requestDeclaresVariantProtocol(request: Request): boolean {
  return String(request.headers.get(VARIANT_PROTOCOL_HEADER) ?? '').trim() === '1'
}
