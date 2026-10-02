/**
 * feat/station-screens-v1 — every string in the "pair a screen" settings UI
 * (components/settings/station-screens-pairing-section.tsx) and the three admin routes behind it
 * (app/api/admin/terminals/stations*). One module, greppable, same convention as
 * lib/stations/copy.ts and lib/dashboard/feed-connection-copy.ts.
 *
 * TWO THINGS THE COPY EXISTS TO CARRY, NOT JUST THE UI:
 *
 *  1. THE CODE IS SHOWN ONCE. It is not persisted anywhere retrievable — not in this browser's
 *     storage, not by a later GET. Closing the dialog without recording it means generating a new
 *     one, which is why the dialog says so before the manager can dismiss it, not as a footnote.
 *
 *  2. REVOKING AND REISSUING ARE THE SAME BLAST RADIUS. Both flip the terminal row out of
 *     'active', so a screen that is currently working stops the moment either fires — the next
 *     request from that screen, including its own silent token refresh, gets refused. Reissuing
 *     an already-working screen breaks it exactly as hard as revoking it; the only difference is
 *     that reissuing leaves a fresh code ready to re-pair with. Both confirmations say this
 *     plainly rather than letting "reissue" read as the gentle option.
 */

export const STATION_PAIRING_COPY = {
  section: {
    heading: 'Kitchen & bar screens',
    description:
      'Pair a wall-mounted kitchen or bar screen to this restaurant. A screen only shows what it is paired to.',
    pairButton: 'Pair a screen',
  },

  /** The "which screen" step, before a code is generated. */
  choose: {
    heading: 'Pair a screen',
    instructions: 'Choose which screen this code will pair. Each screen sees only its own board.',
    kitchenLabel: 'Kitchen',
    kitchenHint: 'Ready-to-run and outstanding items, grouped by table.',
    barLabel: 'Bar',
    barHint: 'Rounds appear here as they come in. Tap one when it goes out.',
    nameLabel: 'Name (optional)',
    namePlaceholder: (defaultName: string) => defaultName,
    generateButton: 'Generate code',
    generatingButton: 'Generating…',
    cancelButton: 'Cancel',
  },

  /** Default names when the manager leaves the name field blank. */
  /**
   * INSTALLING THE STATION AS AN APP ON THE SCREEN ITSELF.
   *
   * Staff were typing flashtap.app/kitchen by hand, which is how a screen standing in Riviera got
   * paired to another venue on 2026-09-02. These words are aimed at whoever sets the screen up
   * once -- a manager or an owner -- not at the cook who uses it every day, so they may say
   * "Chrome" and "install". The cook never sees this page; they see an icon.
   */
  launch: {
    heading: 'Put Kitchen and Bar on the screen itself',
    body:
      'Open this page on the screen that will stand in the kitchen or behind the bar, then install it there. It becomes an app with its own icon, and that icon always opens the same station.',
    openKitchen: 'Open the Kitchen screen',
    openBar: 'Open the Bar screen',
    installHeading: 'To install it on that screen',
    installSteps: [
      'Open the station above on the screen that will keep it.',
      'In Chrome, click the install icon at the right of the address bar.',
      'Confirm. The icon appears on the desktop and in the Start menu.',
    ],
    /** The one thing that is easy to get wrong, said plainly. */
    pairingNote:
      'Installing does not pair the screen. Pair it once with a code from this page, and it stays paired after that.',
    venueNote:
      'The app always shows the venue the screen is paired to. It is not in the address, so it cannot be changed by editing a shortcut.',
  },
  defaultName: {
    kitchen: 'Kitchen Screen',
    bar: 'Bar Screen',
  },

  /** The one-time code dialog. Every string here exists to make "once" impossible to miss. */
  codeIssued: {
    heading: 'Activation code',
    /** Sits ABOVE the code, not below it — the warning has to be read before the code is. */
    onceWarning: 'This code is shown once. It will not be shown again after you close this window.',
    instructions: (stationLabel: string) =>
      `On the ${stationLabel} screen, open the activation page and enter this code.`,
    /** Countdown label; `mmss` is pre-formatted "MM:SS" by the component, ticking live. */
    expiresIn: (mmss: string) => `Expires in ${mmss}`,
    expired: 'This code has expired. Generate a new one.',
    /**
     * ONE-CLICK PAIRING. The same code, carried instead of retyped — see
     * lib/stations/activation-link.ts for why this reuses the code rather than minting a
     * second kind of secret. The typed instructions above stay: they are the fallback when
     * the screen cannot reach this page, and for anyone who would rather read the characters.
     */
    linkHeading: 'Or open it straight on the screen',
    linkBody: (stationLabel: string) =>
      `Open this link on the ${stationLabel} screen and it pairs itself. The link works once and expires with the code.`,
    copyLinkButton: 'Copy link',
    copiedLinkButton: 'Link copied',
    copyButton: 'Copy code',
    copiedButton: 'Copied',
    /** The exit — deliberately not "Done", which reads as "task complete" for something that
     *  is not recorded anywhere. "Close" plus the restated warning is the honest pairing. */
    closeButton: 'Close',
    closeConfirmHeading: 'Close without saving this code?',
    closeConfirmBody:
      "This code will not be shown again. If you haven't entered it on the screen yet, you'll need to generate a new one.",
    closeConfirmDismiss: 'Go back',
    closeConfirmProceed: 'Close anyway',
  },

  /** The paired-screens list. */
  list: {
    emptyHeading: 'No screens paired yet',
    emptyBody: 'Pair a kitchen or bar screen to get started.',
    columnStation: 'Screen',
    columnStatus: 'Status',
    columnPaired: 'Paired',
    columnLastSeen: 'Last seen',
    pairedNever: 'Not yet activated',
    pairedAt: (relative: string) => `Paired ${relative}`,
    lastSeenNever: 'Never',
    lastSeenAt: (relative: string) => relative,
    /** A screen that has a live, unexpired code sitting unused. */
    waitingForCode: (mmss: string) => `Waiting for code (expires in ${mmss})`,
    codeExpired: 'Code expired — reissue to pair',
    reissueButton: 'Reissue code',
    reissuingButton: 'Reissuing…',
    revokeButton: 'Revoke',
    revokingButton: 'Revoking…',
  },

  status: {
    active: 'Active',
    pending: 'Not yet paired',
    revoked: 'Revoked',
    inactive: 'Inactive',
  },

  station: {
    kitchen: 'Kitchen',
    bar: 'Bar',
  },

  /** Shared blast-radius warning, reused verbatim in both confirm dialogs per the docblock. */
  disruptionWarning:
    'If this screen is currently in use, it will stop working the moment you do this — the kitchen or bar board will go blank until the new code is entered.',

  revokeConfirm: {
    heading: (screenName: string) => `Revoke "${screenName}"?`,
    body: 'This screen will no longer be able to reach its board. Pair a new screen in its place at any time.',
    confirmButton: 'Revoke screen',
    cancelButton: 'Cancel',
  },

  reissueConfirm: {
    heading: (screenName: string) => `Reissue a code for "${screenName}"?`,
    body: 'The current code and session for this screen are invalidated immediately, whether or not this screen is currently working.',
    confirmButton: 'Reissue code',
    cancelButton: 'Cancel',
  },

  toast: {
    revoked: (screenName: string) => `"${screenName}" revoked.`,
    reissued: 'New code generated.',
    paired: 'Code generated.',
    loadFailed: 'Could not load paired screens.',
    pairFailed: 'Could not generate a code.',
    revokeFailed: 'Could not revoke this screen.',
    reissueFailed: 'Could not reissue a code.',
    copied: 'Code copied to clipboard.',
    copyFailed: 'Could not copy to clipboard.',
  },

  permission: {
    /** Shown instead of the whole section when the signed-in user lacks terminal:auth:manage. */
    denied: 'Only an owner or manager can pair kitchen and bar screens.',
  },
} as const
