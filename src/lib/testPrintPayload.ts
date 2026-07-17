/* eslint-disable no-bitwise -- byte masking, not a typo'd logical op */
import {encodeBase64} from './base64';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function pushText(bytes: number[], text: string): void {
  for (let i = 0; i < text.length; i++) {
    bytes.push(text.charCodeAt(i) & 0xff);
  }
}

/**
 * A standalone diagnostic payload, not a receipt -- staff can confirm the printer works
 * without a real transaction. Deliberately built locally (not fetched from the backend
 * renderer): there's no receipt_document behind a test print, so it must never be logged to
 * receipt_deliveries, which requires a real receipt_document_id.
 */
export function buildTestPrintPayload(printerName: string): string {
  const bytes: number[] = [];

  bytes.push(ESC, 0x40); // init
  bytes.push(ESC, 0x61, 0x01); // center
  bytes.push(ESC, 0x45, 0x01); // bold on
  pushText(bytes, 'FlashTap Test Print');
  bytes.push(LF);
  bytes.push(ESC, 0x45, 0x00); // bold off
  pushText(bytes, printerName);
  bytes.push(LF);
  pushText(bytes, new Date().toLocaleString());
  bytes.push(LF);
  bytes.push(ESC, 0x61, 0x00); // left
  pushText(bytes, '--------------------------------');
  bytes.push(LF);
  pushText(bytes, 'If you can read this, the');
  bytes.push(LF);
  pushText(bytes, 'connection is working.');
  bytes.push(LF);
  bytes.push(ESC, 0x64, 0x03); // feed 3 lines
  bytes.push(GS, 0x56, 0x01); // cut

  return encodeBase64(Uint8Array.from(bytes));
}
