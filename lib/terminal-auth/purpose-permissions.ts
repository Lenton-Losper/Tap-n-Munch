import { PERMISSIONS, Permission } from '@/lib/permissions'

/** Server-side purpose → permission map. Clients cannot choose permissions directly. */
export const TERMINAL_AUTHORIZATION_PURPOSES = {
  refund: PERMISSIONS.PAYMENTS_REFUND,
  // Cash settlement is not gated on holding a token -- see the terminal tab settle route --
  // but when the terminal does supply one it is verified through this same purpose, so the
  // staff member credited with taking the cash is one who could actually process a payment.
  cash_settlement: PERMISSIONS.PAYMENTS_PROCESS,
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
