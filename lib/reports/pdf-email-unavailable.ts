export const PDF_EMAIL_UNAVAILABLE_MESSAGE =
  'PDF export is temporarily unavailable. CSV reports continue to work normally.'

export function isPdfEmailUnavailableError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    message === PDF_EMAIL_UNAVAILABLE_MESSAGE ||
    lower.includes('pdf export is temporarily unavailable') ||
    lower.includes('webassembly.instantiate') ||
    lower.includes('wasm code generation disallowed')
  )
}
