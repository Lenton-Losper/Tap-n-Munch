/** Compact local timestamp for thermal slips (ESC/POS + SDK6). */
export function formatThermalIssuedAt(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = date.toLocaleString('en-GB', { month: 'short' })
  const year = date.getFullYear()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day} ${month} ${year} ${hours}:${minutes}`
}
