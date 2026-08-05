/**
 * Copy for the "Printer service resolution" section on Diagnostics (#164).
 *
 * WHY THIS IS A MODULE AND NOT INLINE STRINGS. The section was written when SDK6 was the only
 * transport, so it hardcoded `WisePosSdk.initPosSdk` and the USDK action
 * (`com.wisepos.aidl.service`). Since the SDK4 binder-pool transport shipped (dc9e352) the app
 * on our P5 units resolves a DIFFERENT action and never calls initPosSdk at all, so the fixed
 * copy named a service that is not in use and an entry point that is never invoked — it
 * misdirects whoever is holding the terminal.
 *
 * Kept free of react-native imports so the exact strings a technician reads off the screen can
 * be asserted directly in a unit test, rather than inferred from the screen source.
 */

export type PrinterTransport = 'sdk4' | 'sdk6' | 'none';

/**
 * The action each transport resolves via queryIntentServices before it can bind.
 *
 * Mirrors the native constants: `WiseSdk4PrinterModule.BINDER_POOL_ACTION` and
 * `WisePosSdkBootstrap.USDK_ACTION`. Both transports require EXACTLY ONE match — they differ in
 * the action, the entry point, and how the failure surfaces.
 */
export const PROBED_ACTION: {readonly [K in Exclude<PrinterTransport, 'none'>]: string} = {
  sdk4: 'wangpos.sdk4.base.service.BinderPoolService',
  sdk6: 'com.wisepos.aidl.service',
};

/** The action this transport probes, or null when no printer transport is present. */
export function probedActionFor(transport: PrinterTransport): string | null {
  return transport === 'none' ? null : PROBED_ACTION[transport];
}

/**
 * The explanatory line under the section title: which entry point resolves what, and what
 * happens when the count is not one.
 */
export function resolutionHint(transport: PrinterTransport): string {
  switch (transport) {
    case 'sdk4':
      return (
        `SDK4 transport. new Printer(context) resolves ${PROBED_ACTION.sdk4} and needs ` +
        'EXACTLY ONE service to answer it. On 0 or 2+ getExplicitIntent returns null and ' +
        'bindService throws. This is that count.'
      );
    case 'sdk6':
      return (
        `SDK6 transport. WisePosSdk.initPosSdk resolves ${PROBED_ACTION.sdk6} and needs ` +
        'EXACTLY ONE service to answer it. On 0 or 2+ it binds a null Intent and fails with ' +
        '7101. This is that count.'
      );
    case 'none':
      return (
        'No built-in printer transport is present in this build, so nothing resolves a ' +
        'printer service. This count is not meaningful here.'
      );
  }
}

/** Only the fields of the probe the verdict is derived from. */
export interface ResolutionProbe {
  /** The action native actually queried — ground truth, preferred over the transport default. */
  action?: string;
  /** Negative means the probe could not run on this build. */
  matchCount: number;
}

/**
 * The verdict under the match count.
 *
 * DERIVED, NOT FIXED. The old matchCount===1 string asserted "resolution is fine, fault is
 * elsewhere" — a conclusion about where the fault lives, which this probe cannot establish. It
 * only establishes whether the SDK can bind. Say that, and name the action it was established
 * for, so the line stays true whatever else is or is not broken.
 */
export function resolutionVerdict(
  transport: PrinterTransport,
  probe: ResolutionProbe | null,
  probing: boolean,
): string {
  if (probing) return 'probing…';
  if (probe == null) return '';
  if (probe.matchCount < 0) return 'probe unavailable on this build';

  const action = probe.action || probedActionFor(transport) || 'the printer action';
  if (probe.matchCount === 0) {
    return `ZERO — nothing answers ${action} for this app`;
  }
  if (probe.matchCount === 1) {
    return `OK — exactly one service answers ${action}, so the SDK can bind`;
  }
  return `AMBIGUOUS — ${probe.matchCount} services answer ${action}, fixable in code`;
}
