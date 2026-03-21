import QRCode from 'qrcode'

const TEN_MINUTES_MS = 10 * 60 * 1000

export async function generateTransactionQr(paymentUrl, now = Date.now()) {
  if (!paymentUrl || typeof paymentUrl !== 'string') {
    throw new Error('paymentUrl is required to generate QR code')
  }

  const expiresAt = new Date(now + TEN_MINUTES_MS).toISOString()
  const qrOptions = {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
  }

  const [base64Png, svg] = await Promise.all([
    QRCode.toDataURL(paymentUrl, qrOptions),
    QRCode.toString(paymentUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  ])

  return {
    paymentUrl,
    base64Png,
    svg,
    expiresAt,
  }
}

export function isQrExpired(expiresAt, now = Date.now()) {
  return !expiresAt || Number.isNaN(Date.parse(expiresAt)) || now >= Date.parse(expiresAt)
}
