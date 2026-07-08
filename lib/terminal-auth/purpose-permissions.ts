import { PERMISSIONS, Permission } from '@/lib/permissions'

/** Server-side purpose → permission map. Clients cannot choose permissions directly. */
export const TERMINAL_AUTHORIZATION_PURPOSES = {
  refund: PERMISSIONS.PAYMENTS_REFUND,
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
