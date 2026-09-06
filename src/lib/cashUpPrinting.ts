/**
 * PRINTING THE END-OF-DAY CASH-UP.
 *
 * ================================================================================================
 * WHAT THIS SHARES WITH receiptPrinting, AND WHAT IT DELIBERATELY DOES NOT
 * ================================================================================================
 *
 * SHARED, unchanged: getPrinterConfig, runBluetoothPrintJob, printBuiltInJob, paperTypeFromWidthMm.
 * Those know how to talk to the two transports and nothing about what they are printing, which is
 * exactly why they are reusable. The whole device-side cost of this feature is this file.
 *
 * NOT SHARED: printReceiptForOrder. It is built around an order id, an issued receipt document and
 * a receipt_deliveries row, and a cash-up has none of those. Reusing it would have meant threading
 * a "this is not a receipt" flag through a money path to reach the ten lines below.
 *
 * ================================================================================================
 * NOTHING IS RECORDED, AND THAT IS THE DESIGN
 * ================================================================================================
 *
 * A receipt print writes a receipt_deliveries row because a receipt is a document the venue owes
 * somebody and a failed delivery has to be visible. A cash-up is a read: the same period reprints
 * identically, so a failed print is a REPRINT and never a correction. Adding a delivery log here
 * would create a record implying the opposite.
 *
 * The one thing that is recorded happens server-side and would happen anyway: consuming the PIN
 * token writes an authorization_events row, so "who asked for the takings, and when" is answerable
 * without this file logging anything.
 *
 * ================================================================================================
 * THE REPORT IS FETCHED ONCE AND PRINTED ONCE
 * ================================================================================================
 *
 * The token is single-use and is spent by the fetch. If the printer then refuses the paper, the
 * report is already in hand and the failure is reported as a PRINTER failure — the caller must not
 * silently re-fetch, because that needs a second PIN and would look to the manager like the first
 * one did not work.
 */
import {getPrinterConfig, TerminalPrinterConfig} from './api';
import {getCashUpReport, type CashUpPreset, type CashUpReport} from './api';
import {paperTypeFromWidthMm} from './paperWidth';
import {runBluetoothPrintJob} from './printer';
import {printBuiltInJob} from './wiseSdk6Printer';

export interface PrintCashUpResult {
  success: boolean;
  errorCode?: string;
  /** Staff-facing text. Never a raw SDK string. */
  error?: string;
  /** Present on success, so the screen can say what was in the period without a second call. */
  report?: CashUpReport;
}

/**
 * THE PRINTER IS READ FIRST, BEFORE THE PIN IS SPENT.
 *
 * Asking for a manager's PIN and then discovering there is no printer configured wastes a
 * single-use token and sends somebody to Settings having already typed a code. The config read is
 * cheap and answers the question that makes the rest pointless.
 */
export async function printCashUp(
  params: {
    preset: CashUpPreset;
    staffUserId: string;
    authorizationTokenId: string;
  },
  token: string,
): Promise<PrintCashUpResult> {
  let config: TerminalPrinterConfig | null = null;
  try {
    config = await getPrinterConfig(token);
  } catch {
    config = null;
  }

  if (!config) {
    return {
      success: false,
      errorCode: 'NO_PRINTER_CONFIGURED',
      error: 'No printer is set up on this terminal',
    };
  }

  let report: CashUpReport;
  try {
    report = await getCashUpReport(
      {
        preset: params.preset,
        staffUserId: params.staffUserId,
        authorizationTokenId: params.authorizationTokenId,
        // The terminal's own stored width, so the layout matches the paper actually loaded (#167:
        // before this, the built-in path let a native constant decide and the stored value did
        // nothing).
        characterWidth: config.character_width ?? null,
      },
      token,
    );
  } catch (err) {
    // Re-thrown so the screen can branch on the coded refusals — a rejected PIN reads differently
    // from a report that could not be built, and both differ from a printer that would not take it.
    throw err;
  }

  if (config.connection_type === 'BUILTIN') {
    if (!Array.isArray(report.sdk6Lines) || report.sdk6Lines.length === 0) {
      return {
        success: false,
        errorCode: 'CASH_UP_FORMAT_UNAVAILABLE',
        error: 'The built-in printer needs structured lines and the cash-up carried none',
        report,
      };
    }
    const printed = await printBuiltInJob(report.sdk6Lines, {
      paperType: paperTypeFromWidthMm(config.paper_width_mm),
    });
    return printed.success
      ? {success: true, report}
      : {
          success: false,
          errorCode: printed.errorCode ?? 'PRINT_FAILED',
          error: printed.error ?? 'Failed to print the cash-up',
          report,
        };
  }

  if (!config.printer_address) {
    return {
      success: false,
      errorCode: 'NO_PRINTER_CONFIGURED',
      error: 'No printer is paired with this terminal',
      report,
    };
  }

  const printed = await runBluetoothPrintJob({
    printerAddress: config.printer_address,
    escposBase64: report.escposBase64,
  });

  return printed.success
    ? {success: true, report}
    : {
        success: false,
        errorCode: printed.errorCode ?? 'PRINT_FAILED',
        error: printed.error ?? 'Failed to print the cash-up',
        report,
      };
}
