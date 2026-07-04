import { ReportData } from './get-report-data'
import { generatePdfBlob } from './generate-pdf-lib'

export { generatePdfBlob, generatePdfBytes } from './generate-pdf-lib'

export async function downloadPdf(report: ReportData, filename?: string): Promise<void> {
  const blob = await generatePdfBlob(report)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `flashtap-report-${report.filters.startDate}-to-${report.filters.endDate}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
