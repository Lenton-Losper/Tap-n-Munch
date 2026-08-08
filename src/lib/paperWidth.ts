/**
 * Paper-width plumbing for the built-in (SDK4) printer.
 *
 * `terminal_printer_configs.paper_width_mm` is stored and editable, but no call site ever
 * passed it to the native module, so a hardcoded DEFAULT_PAPER_TYPE decided the width instead
 * (#167). These helpers turn the stored millimetre value into the option the module accepts.
 *
 * Why paperType and not paperWidthMm: WiseSdk4PrinterModule takes either, but they select
 * different native calls -- `paperWidthMm` routes to setPrintPaperWide(), which has never been
 * exercised on our P5 units, while `paperType` routes to setPrintPaperType(), the call every
 * print already makes and the one known to return 0 on this hardware. Sending the stored value
 * through the existing call changes the value without changing the call sequence. Switching to
 * setPrintPaperWide is a separate change that needs a device to validate.
 */

/** Mirrors WiseSdk4PrinterModule's PAPER_TYPE_* constants. */
export const PAPER_TYPE_58MM = 0;
export const PAPER_TYPE_80MM = 1;
export const PAPER_TYPE_104MM = 2;

/**
 * An unrecognised or missing width falls back to 80mm -- matching WiseSdk4PrinterModule's
 * DEFAULT_PAPER_TYPE exactly, so a config without a usable value prints precisely as it does
 * today. This is NOT an endorsement of 80mm: #167 argues 58mm is what the rest of the system
 * assumes (Printer.PAPER_WIDTH is 384 dots, parseCharacterWidth defaults to 32 characters), and
 * that is probably right. But the physical roll on the P5 has never been measured, so changing
 * the fallback would alter printed layout on an unverified assumption. Settle it with a ruler
 * and a receipt, not here.
 */
export function paperTypeFromWidthMm(mm: number | null | undefined): number {
  switch (mm) {
    case 58:
      return PAPER_TYPE_58MM;
    case 104:
      return PAPER_TYPE_104MM;
    case 80:
      return PAPER_TYPE_80MM;
    default:
      return PAPER_TYPE_80MM;
  }
}
