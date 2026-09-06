/**
 * PRINTING THE CASH-UP: the order of operations, and which transport gets which format.
 *
 * cashUpScreen.test.tsx mocks this module, so nothing there says anything about it. A mutation
 * sweep on 2026-09-07 proved the gap: dropping the paper width and spending the PIN before
 * checking for a printer both left every test green.
 */
const mockGetPrinterConfig = jest.fn();
const mockGetCashUpReport = jest.fn();
const mockBluetooth = jest.fn();
const mockBuiltIn = jest.fn();

jest.mock('../api', () => ({
  getPrinterConfig: (...a: unknown[]) => mockGetPrinterConfig(...a),
  getCashUpReport: (...a: unknown[]) => mockGetCashUpReport(...a),
}));
jest.mock('../printer', () => ({runBluetoothPrintJob: (...a: unknown[]) => mockBluetooth(...a)}));
jest.mock('../wiseSdk6Printer', () => ({printBuiltInJob: (...a: unknown[]) => mockBuiltIn(...a)}));
jest.mock('../paperWidth', () => ({paperTypeFromWidthMm: (mm: number) => `paper-${mm}`}));

import {printCashUp} from '../cashUpPrinting';

const REPORT = {
  period: {},
  summary: {},
  escposBase64: 'QkFTRTY0',
  sdk6Lines: [{type: 'text', text: 'CASH-UP', align: 'center'}],
};

const PARAMS = {preset: 'today' as const, staffUserId: 'mgr-1', authorizationTokenId: 'auth-1'};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCashUpReport.mockResolvedValue(REPORT);
  mockBluetooth.mockResolvedValue({success: true});
  mockBuiltIn.mockResolvedValue({success: true});
});

describe('the printer is checked BEFORE the PIN is spent', () => {
  it('refuses without fetching the report when no printer is configured', async () => {
    /**
     * The token is single-use and the fetch spends it. Asking for a manager's PIN and then
     * discovering there is no printer wastes it and sends somebody to Settings having already
     * typed a code.
     */
    mockGetPrinterConfig.mockResolvedValue(null);

    const result = await printCashUp(PARAMS, 'jwt');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NO_PRINTER_CONFIGURED');
    expect(mockGetCashUpReport).not.toHaveBeenCalled();
    expect(mockBluetooth).not.toHaveBeenCalled();
    expect(mockBuiltIn).not.toHaveBeenCalled();
  });

  it('treats a failed config read as no printer, never as a printer', async () => {
    mockGetPrinterConfig.mockRejectedValue(new Error('network'));
    const result = await printCashUp(PARAMS, 'jwt');
    expect(result.errorCode).toBe('NO_PRINTER_CONFIGURED');
    expect(mockGetCashUpReport).not.toHaveBeenCalled();
  });
});

describe('the Bluetooth transport', () => {
  beforeEach(() => {
    mockGetPrinterConfig.mockResolvedValue({
      connection_type: 'BLUETOOTH',
      printer_address: 'AA:BB:CC',
      character_width: 48,
      paper_width_mm: 80,
    });
  });

  it('sends the raw bytes to the paired address', async () => {
    const result = await printCashUp(PARAMS, 'jwt');
    expect(result.success).toBe(true);
    expect(mockBluetooth).toHaveBeenCalledWith({
      printerAddress: 'AA:BB:CC',
      escposBase64: 'QkFTRTY0',
    });
    expect(mockBuiltIn).not.toHaveBeenCalled();
  });

  it('asks the server to lay the report out for THIS printer width', async () => {
    // #167: before that fix the stored width had no effect and the built-in path let a native
    // constant decide. A 48-column report on 58mm paper wraps into nonsense.
    await printCashUp(PARAMS, 'jwt');
    expect(mockGetCashUpReport.mock.calls[0][0].characterWidth).toBe(48);
  });

  it('reports a printer failure as one, keeping the report it already paid for', async () => {
    mockBluetooth.mockResolvedValue({success: false, errorCode: 'PRINTER_OFFLINE'});
    const result = await printCashUp(PARAMS, 'jwt');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PRINTER_OFFLINE');
    expect(result.report).toBe(REPORT);
  });

  it('refuses when the config names no address', async () => {
    mockGetPrinterConfig.mockResolvedValue({
      connection_type: 'BLUETOOTH',
      printer_address: null,
      character_width: 32,
    });
    const result = await printCashUp(PARAMS, 'jwt');
    expect(result.errorCode).toBe('NO_PRINTER_CONFIGURED');
    expect(mockBluetooth).not.toHaveBeenCalled();
  });
});

describe('the built-in transport', () => {
  beforeEach(() => {
    mockGetPrinterConfig.mockResolvedValue({
      connection_type: 'BUILTIN',
      printer_address: null,
      character_width: 32,
      paper_width_mm: 58,
    });
  });

  it('sends the STRUCTURED lines, because WisePosSdk has no raw-byte write', async () => {
    const result = await printCashUp(PARAMS, 'jwt');
    expect(result.success).toBe(true);
    expect(mockBuiltIn).toHaveBeenCalledWith(REPORT.sdk6Lines, {paperType: 'paper-58'});
    expect(mockBluetooth).not.toHaveBeenCalled();
  });

  it('routes the stored paper width, not a native default', async () => {
    await printCashUp(PARAMS, 'jwt');
    expect(mockBuiltIn.mock.calls[0][1]).toEqual({paperType: 'paper-58'});
  });

  it('refuses rather than printing nothing when the lines are missing', async () => {
    mockGetCashUpReport.mockResolvedValue({...REPORT, sdk6Lines: []});
    const result = await printCashUp(PARAMS, 'jwt');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CASH_UP_FORMAT_UNAVAILABLE');
    expect(mockBuiltIn).not.toHaveBeenCalled();
  });
});

describe('a refused report', () => {
  it('is rethrown so the screen can tell a PIN problem from a printer problem', async () => {
    mockGetPrinterConfig.mockResolvedValue({connection_type: 'BUILTIN', character_width: 32});
    mockGetCashUpReport.mockRejectedValue(Object.assign(new Error('no'), {code: 'AUTHORIZATION_INVALID'}));
    await expect(printCashUp(PARAMS, 'jwt')).rejects.toMatchObject({code: 'AUTHORIZATION_INVALID'});
    expect(mockBuiltIn).not.toHaveBeenCalled();
  });
});
