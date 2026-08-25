/**
 * #120's RESIDUAL — the release action's wording. SIGNED BY THE OWNER 2026-08-25.
 *
 * In its own module rather than inline in a screen, for the reason #334 established: a string
 * living inside a component is invisible to every copy gate, and the one string that mattered is
 * always the one nobody remembered to move. `scripts/check-menu-copy-sourced.mjs` scans `app/menu`,
 * so a staff surface under `components/` would never be caught — which is exactly how the ninth
 * service-model string ended up as a bare literal in `components/ready-to-pay-cash.tsx`.
 *
 * IT MUST READ AS A REPAIR, NOT A ROUTINE ACTION. The owner's words on signing it: "it says what it
 * does and reads as a repair, not a routine action." That is the property to preserve if it is ever
 * edited — this button releases a claim that may still be legitimately in flight (see #215), so it
 * is an escape hatch for a stuck table, not a way to dismiss a round.
 *
 * The same strings serve the staff dashboard and the terminal. There is one action; it should not
 * be described two ways.
 */
export const STRANDED_CLAIM_COPY = {
  /** The button. */
  releaseLabel: 'Release stuck request',
  /**
   * The confirm body. Says what is stuck, what releasing does, and why it helps — in that order,
   * so a member of staff who has never seen this before can act on it without training.
   */
  releaseBody:
    'This request is stuck mid-accept. Releasing it puts it back in the review list so this table can be closed.',
} as const
