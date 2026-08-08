/**
 * #167 — terminal_printer_configs.paper_width_mm and character_width are stored and editable
 * but were never read on the built-in (SDK4) path: printViaBuiltIn called
 * `fetchIssuedReceipt(orderId, token)` and `printBuiltInJob(lines)` with no options at all, so
 * a hardcoded DEFAULT_PAPER_TYPE in the native module decided the width instead.
 *
 * These assert the plumbing at the seam the native module sees: what options object actually
 * reaches printBuiltInJob, and what character width actually reaches the receipts GET.
 *
 * NOT verified here: that the printer physically honours the value. Issue #166 shows
 * setPrintPaperType returning 0 while the head still laid out against its native 384 dots, so
 * the SDK's return code proves nothing. That needs a P5 and a physical receipt.
 */
import {paperTypeFromWidthMm, PAPER_TYPE_58MM, PAPER_TYPE_80MM} from '../paperWidth';

const mockGetPrinterConfig = jest.fn();
const mockGetReceiptForOrder = jest.fn();
const mockPrintBuiltInJob = jest.fn(
  async (..._args: unknown[]): Promise<{success: boolean}> => ({success: true}),
);

jest.mock('../api', () => ({
  getPrinterConfig: (...a: unknown[]) => mockGetPrinterConfig(...a),
  getReceiptForOrder: (...a: unknown[]) => mockGetReceiptForOrder(...a),
  recordReceiptDelivery: jest.fn(async () => undefined),
  sendReceiptEmail: jest.fn(),
  ReceiptNotReadyError: class ReceiptNotReadyError extends Error {},
}));

jest.mock('../wiseSdk6Printer', () => ({
  printBuiltInJob: (...a: unknown[]) => mockPrintBuiltInJob(...a),
}));

jest.mock('../printer', () => ({runBluetoothPrintJob: jest.fn()}));
jest.mock('../storage', () => ({getTerminalId: async () => 'device-1'}));
jest.mock('../receiptPrintSettings', () => ({
  getReceiptPrintingEnabled: async () => true,
  recordLastPrintResult: jest.fn(async () => undefined),
  describeReceiptPrintError: () => 'Printing failed',
}));

const {printReceiptForOrder} = require('../receiptPrinting');

const configWith = (paperWidthMm: number, characterWidth: number | null) => ({
  id: 'cfg-1',
  terminal_id: 'c103a8bd-0000-0000-0000-000000000000',
  connection_type: 'BUILTIN',
  printer_name: 'Built-in printer',
  printer_address: 'BUILTIN',
  paper_width_mm: paperWidthMm,
  character_width: characterWidth,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrintBuiltInJob.mockResolvedValue({success: true});
  mockGetReceiptForOrder.mockResolvedValue({
    id: 'receipt-1',
    sdk6Lines: [{type: 'text', text: 'FlashTap', align: 'CENTER'}],
  });
});

describe('paperTypeFromWidthMm', () => {
  it('maps the stored millimetre width onto the SDK4 paper-type constant', () => {
    expect(paperTypeFromWidthMm(58)).toBe(PAPER_TYPE_58MM);
    expect(paperTypeFromWidthMm(80)).toBe(PAPER_TYPE_80MM);
    expect(paperTypeFromWidthMm(104)).toBe(2);
  });

  /**
   * The fallback must equal WiseSdk4PrinterModule's DEFAULT_PAPER_TYPE (80mm), so a config
   * with no usable width prints exactly as it does today. #167 argues 58mm is the more
   * defensible value, but the physical roll has never been measured and changing an
   * unmeasured default would alter layout on a live unit. Deliberately pinned, not endorsed.
   */
  it('falls back to 80mm, matching the native default, for a missing or unrecognised width', () => {
    expect(paperTypeFromWidthMm(null)).toBe(PAPER_TYPE_80MM);
    expect(paperTypeFromWidthMm(undefined)).toBe(PAPER_TYPE_80MM);
    expect(paperTypeFromWidthMm(72)).toBe(PAPER_TYPE_80MM);
  });
});

describe('built-in receipt print reads the stored printer config (#167)', () => {
  it('passes the configured paper width through to the native module', async () => {
    mockGetPrinterConfig.mockResolvedValue(configWith(80, null));

    await printReceiptForOrder('order-1', 'token-1');

    expect(mockPrintBuiltInJob).toHaveBeenCalledTimes(1);
    const options = mockPrintBuiltInJob.mock.calls[0][1];
    expect(options).toEqual(
      expect.objectContaining({paperType: PAPER_TYPE_80MM}),
    );
  });

  /**
   * The Finatic-UAT P5's config row stores 80, and the native DEFAULT_PAPER_TYPE this replaces
   * was also 80mm. So for that device the declaration sent to setPrintPaperType is byte-for-byte
   * what it was before plumbing: honouring the stored value cannot move it 384 -> 576. Only a
   * terminal whose stored width is NOT 80 sees a changed declaration.
   */
  it('sends the same paperType the native default already sent when the config stores 80', async () => {
    mockGetPrinterConfig.mockResolvedValue(configWith(80, null));

    await printReceiptForOrder('order-1', 'token-1');

    // PAPER_TYPE_80MM is exactly WiseSdk4PrinterModule's unchanged DEFAULT_PAPER_TYPE.
    expect(mockPrintBuiltInJob.mock.calls[0][1]).toEqual(
      expect.objectContaining({paperType: PAPER_TYPE_80MM}),
    );
  });

  it('sends 58mm when the config says 58mm, so the value governs rather than a constant', async () => {
    mockGetPrinterConfig.mockResolvedValue(configWith(58, null));

    await printReceiptForOrder('order-1', 'token-1');

    expect(mockPrintBuiltInJob.mock.calls[0][1]).toEqual(
      expect.objectContaining({paperType: PAPER_TYPE_58MM}),
    );
  });

  it('passes the configured character width to the receipts GET', async () => {
    mockGetPrinterConfig.mockResolvedValue(configWith(58, 32));

    await printReceiptForOrder('order-1', 'token-1');

    expect(mockGetReceiptForOrder).toHaveBeenCalledWith('order-1', 'token-1', 32);
  });

  it('leaves character width undefined when the config has none', async () => {
    mockGetPrinterConfig.mockResolvedValue(configWith(58, null));

    await printReceiptForOrder('order-1', 'token-1');

    expect(mockGetReceiptForOrder).toHaveBeenCalledWith(
      'order-1',
      'token-1',
      undefined,
    );
  });
});
