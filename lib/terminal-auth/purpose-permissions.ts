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
  /**
   * A WALKOUT — closing a tab that still owes money, so the table can be turned.
   *
   * WHY A PIN AT ALL. Closing an unpaid tab writes off a debt. The waiter holding the terminal is
   * the person the money was owed to, and asking them to approve their own shortfall is not a
   * control. The PIN puts a second, named person on the record before the table is freed.
   *
   * THE PERMISSION IS TABS_CLOSE_UNPAID, NOT TABLES_MANAGE, and that is the whole reason a new
   * permission exists rather than a reused one. Measured 2026-09-04 against the shipped role
   * config:
   *
   *     tables:manage     owner, manager, WAITER
   *     payments:process  owner, manager, cashier
   *     payments:refund   nobody, by default
   *
   * `tables:manage` is arranging the floor and waiters legitimately hold it, so gating on it would
   * let the person being walked out on sign off the loss. `payments:process` includes cashier, and
   * taking payment is a different authority from writing off a debt. Neither fits, so one exists
   * that does: manager and owner only.
   *
   * THE IDENTITY THIS PRODUCES IS A users.id, and it is what lands in the audit trail as the person
   * who authorised the write-off. Before this, a close recorded `closed_by: <terminal id>` -- the
   * DEVICE it happened on, which answers "which box" and never "who".
   */
  walkout_close: PERMISSIONS.TABS_CLOSE_UNPAID,
  /**
   * VOIDING A LINE — taking food off a bill after it was ordered.
   *
   * WHY A PIN. A void reduces what the customer owes, with no money moving and no receipt to
   * check it against afterwards. The waiter holding the terminal took the order and is the person
   * with the most reason to remove it; asking them to approve their own void is not a control.
   * The PIN puts a second, named person on the record before the food leaves the bill.
   *
   * THE PERMISSION IS ORDERS_VOID, NOT ORDERS_UPDATE. `orders:update` rides on the terminal's own
   * JWT and every waiter holds it, so gating on it would mean anyone who can ring a dish up can
   * make it disappear from the bill — which is the gap this closes. Manager and owner only.
   *
   * THE IDENTITY THIS PRODUCES IS A users.id, and that is what fixes the hole this feature
   * shipped with: `app/api/terminal/tabs/[tabId]/amend/route.ts` passed `p_actor_user_id: null`,
   * so a void recorded NO HUMAN AT ALL — only that "a terminal" did it.
   *
   * *** ADDING A PURPOSE HERE IS HALF THE JOB. *** The database keeps its own allow-list on
   * `privileged_authorization_tokens.purpose`, and it has been forgotten THREE times already
   * (service_session, menu_availability, walkout_close). When it is missed, POST
   * /api/terminal/authorize passes every application check — membership, permission, PIN,
   * lockout — and then fails on the INSERT with a 23514: the staff member types a correct PIN and
   * is told authorization failed, every time. See
   * supabase/migrations/20260906120000_authorization_purpose_line_void.sql.
   */
  line_void: PERMISSIONS.ORDERS_VOID,
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
