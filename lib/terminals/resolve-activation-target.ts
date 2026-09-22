/**
 * WHICH TERMINAL ROW A DEVICE IS ACTIVATING INTO.
 *
 * ==================================================================================================
 * THE INVARIANT THIS PRESERVES
 * ==================================================================================================
 *
 * ONE PHYSICAL DEVICE OWNS EXACTLY ONE TERMINAL ROW, GLOBALLY. That is what
 * `restaurant_terminals_device_id_unique` and `restaurant_terminals_device_serial_unique` assert,
 * and it is the right invariant: a till standing in one venue must not simultaneously be a till in
 * another, because `terminal_id` is what a payment, a printer config and an audit row are attributed
 * to. Neither index is removed or weakened here.
 *
 * ==================================================================================================
 * THE BUG THIS CLOSES
 * ==================================================================================================
 *
 * Before terminal 2.38, `activateTerminal()` sent only the code, so `device_id` stayed NULL (NULLs
 * do not collide) and `device_serial` was `ft-<row uuid>` -- unique by construction. F19, in 2.38,
 * started sending the device's real ANDROID_ID. From then on the device's own identity occupies both
 * unique indexes.
 *
 * `reissue-code` was, and remains, the sanctioned way to re-activate: it flips the SAME row back to
 * pending, so the device rebinds to the row it already owns and nothing collides. But
 * `generate-code` mints a NEW row, and an operator has no way to tell from the outside which they
 * need. Point a reinstalled device at a new row and the route tried to write an identity another row
 * already held: 23505, every time, for ever. ANDROID_ID survives reinstall (it is keyed to the
 * signing key), so the device could never activate again.
 *
 * ==================================================================================================
 * THIS IS NOT A SECURITY BOUNDARY, AND SAYING SO MATTERS
 * ==================================================================================================
 *
 * `deviceId` and `terminalSn` are SELF-ASSERTED by the caller and verified against nothing -- the
 * open half of #241, recorded on `generateTerminalActivationCode`. The unique indexes are a
 * DUPLICATE-REGISTRATION guard, not proof of who is calling. So rebinding a device to the row it
 * already owns grants no authority that presenting the same valid code would not already grant; the
 * activation code is the credential, and it is unchanged.
 *
 * What rebinding DOES protect is the cross-venue case, which is why that one is refused outright.
 */

/** A row that already holds the identity the caller is presenting. */
export type IdentityHolder = {
  id: string
  restaurant_id: string
}

export type ActivationTargetDecision =
  /** Nobody holds this identity. Activate the row the code named, as before. */
  | { kind: 'activate_code_row' }
  /**
   * This device already owns a row IN THE SAME RESTAURANT. Activate THAT row and retire the one the
   * code named, so the device keeps its history instead of growing a second identity.
   */
  | { kind: 'rebind_existing'; terminalId: string; supersededTerminalId: string }
  /** The device owns a row in ANOTHER restaurant. Refused -- see the header. */
  | { kind: 'reject_cross_restaurant' }

/**
 * Decide, given the row the activation code named and any row already holding the presented device
 * identity.
 *
 * `holders` is every row matching the presented `device_id` OR `device_serial`, the code row
 * included -- the caller does not have to pre-filter it.
 */
export function resolveActivationTarget(params: {
  codeRow: { id: string; restaurant_id: string }
  holders: readonly IdentityHolder[]
}): ActivationTargetDecision {
  const codeRowId = String(params.codeRow.id)
  const codeRestaurant = String(params.codeRow.restaurant_id)

  // The code's own row holding the identity is not a conflict -- that is a device re-activating
  // through `reissue-code`, which already worked and must keep working.
  const others = (params.holders ?? []).filter((h) => String(h.id) !== codeRowId)
  if (others.length === 0) return { kind: 'activate_code_row' }

  /**
   * ANY holder in another restaurant refuses the whole attempt. Checked before the same-restaurant
   * case deliberately: if a device's identity were somehow spread across two venues, rebinding to
   * whichever happened to match this one would silently pick a winner and move a till between
   * businesses. Refusing is the answer a human has to look at.
   */
  if (others.some((h) => String(h.restaurant_id) !== codeRestaurant)) {
    return { kind: 'reject_cross_restaurant' }
  }

  /**
   * More than one row in the SAME restaurant should be impossible -- the unique indexes allow one
   * holder per column, so at most `device_id`'s row and `device_serial`'s row, and in practice both
   * are the same row. If they ever differ, refusing is safer than guessing which identity is the
   * real device.
   */
  const distinct = [...new Set(others.map((h) => String(h.id)))]
  if (distinct.length > 1) return { kind: 'reject_cross_restaurant' }

  return {
    kind: 'rebind_existing',
    terminalId: distinct[0],
    supersededTerminalId: codeRowId,
  }
}

/**
 * The client-facing message for each refusal.
 *
 * NEVER carries a constraint name, a column, a row id or a PostgREST code. The operator needs to
 * know what to DO; the diagnosis belongs in the server log. This is the half that cost an evening:
 * a 23505 on `restaurant_terminals_device_id_unique` reached the P5 as "Failed to activate
 * terminal", which is true of every possible failure and actionable for none of them.
 */
export const ACTIVATION_REFUSALS = {
  cross_restaurant:
    'This device is already set up for a different restaurant. Remove it there first, then activate it here.',
  identity_taken:
    'This device is already registered to another terminal. Reissue the code on that terminal instead of creating a new one.',
} as const
