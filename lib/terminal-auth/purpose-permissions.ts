import { PERMISSIONS, Permission } from '@/lib/permissions'

/** Server-side purpose → permission map. Clients cannot choose permissions directly. */
export const TERMINAL_AUTHORIZATION_PURPOSES = {
  refund: PERMISSIONS.PAYMENTS_REFUND,
  // Cash settlement is not gated on holding a token -- see the terminal tab settle route --
  // but when the terminal does supply one it is verified through this same purpose, so the
  // staff member credited with taking the cash is one who could actually process a payment.
  cash_settlement: PERMISSIONS.PAYMENTS_PROCESS,
  // ADR-005 §3. A waiter opening a table proves who they are through the SAME PIN machinery as
  // every other privileged terminal action -- lockout, membership, permission, audit -- rather
  // than a second identity path invented for service.
  //
  // The permission is ORDERS_UPDATE and not TABLES_MANAGE: opening a table is the first step of
  // taking an order, and gating it on table administration would mean a waiter who can ring up
  // food cannot start the tab to ring it up onto.
  //
  // THE IDENTITY THIS PRODUCES IS A users.id. It is what lands in tabs.opened_by_user_id and
  // table_assignments.waiter_user_id, and it is why those columns do not reference staff_members.
  service_session: PERMISSIONS.ORDERS_UPDATE,
  /**
   * A waiter marking a dish unavailable from the P5.
   *
   * WHY A PIN AT ALL, when the waiter is already holding an authenticated terminal: this write is
   * not scoped to one table. It removes the dish from EVERY customer's menu at the venue, QR and
   * terminal alike, until someone puts it back. That is a venue-wide change made from a shared
   * device, and "who took the ribeye off" is a question that gets asked.
   *
   * THE PERMISSION IS MENU_WRITE, and it is why this cannot ride on the terminal token alone:
   * TERMINAL_JWT_PERMISSIONS carries only orders:read, orders:update and tables:read. Widening
   * that list would grant menu-writing to every terminal in the estate for the sake of one
   * screen, and would take effect on the next refresh at venues that never asked for it.
   */
  menu_availability: PERMISSIONS.MENU_WRITE,
} as const satisfies Record<string, Permission>

export type TerminalAuthorizationPurpose = keyof typeof TERMINAL_AUTHORIZATION_PURPOSES

export function resolveTerminalAuthorizationPermission(
  purpose: string,
): Permission | null {
  if (purpose in TERMINAL_AUTHORIZATION_PURPOSES) {
    return TERMINAL_AUTHORIZATION_PURPOSES[
      purpose as TerminalAuthorizationPurpose
    ]
  }
  return null
}
