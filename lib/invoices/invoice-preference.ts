import type { InvoiceDetailsPayload } from '@/lib/events/contracts'

export type InvoicePreference = {
  requested: boolean
  details?: InvoiceDetailsPayload
}

export type TaxInvoiceFormValues = {
  email: string
  companyName: string
  vatNumber: string
  department: string
  glNumber: string
  employeeCode: string
  costCentre: string
  businessUnit: string
}

export const EMPTY_TAX_INVOICE_FORM: TaxInvoiceFormValues = {
  email: '',
  companyName: '',
  vatNumber: '',
  department: '',
  glNumber: '',
  employeeCode: '',
  costCentre: '',
  businessUnit: '',
}

export function showFnbCorporateFields(shortCode: string | null | undefined): boolean {
  return String(shortCode || '').trim().toUpperCase() === 'FNB'
}

export function buildInvoiceDetailsFromForm(
  values: TaxInvoiceFormValues,
  includeFnbFields: boolean,
): InvoiceDetailsPayload {
  const metadata: Record<string, unknown> = {}

  if (includeFnbFields) {
    if (values.department.trim()) metadata.department = values.department.trim()
    if (values.glNumber.trim()) metadata.gl_number = values.glNumber.trim()
    if (values.employeeCode.trim()) metadata.employee_code = values.employeeCode.trim()
    if (values.costCentre.trim()) metadata.cost_centre = values.costCentre.trim()
    if (values.businessUnit.trim()) metadata.business_unit = values.businessUnit.trim()
  }

  return {
    email: values.email.trim(),
    company_name: values.companyName.trim() || undefined,
    vat_number: values.vatNumber.trim() || undefined,
    metadata,
  }
}

export function buildInvoicePreferenceFromForm(
  values: TaxInvoiceFormValues,
  includeFnbFields: boolean,
): InvoicePreference {
  return {
    requested: true,
    details: buildInvoiceDetailsFromForm(values, includeFnbFields),
  }
}

export function parseInvoicePreference(raw: unknown): InvoicePreference | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (row.requested !== true) return null
  const details = row.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const email = String((details as Record<string, unknown>).email || '').trim()
  if (!email) return null
  return {
    requested: true,
    details: details as InvoiceDetailsPayload,
  }
}

export function parseInvoicePreferenceFromRequest(body: Record<string, unknown>): InvoicePreference | null {
  const requested =
    body.invoice_requested === true ||
    body.invoiceRequested === true

  if (!requested) return null

  const detailsRaw = (body.invoice_details ?? body.invoiceDetails) as Record<string, unknown> | undefined
  if (!detailsRaw || typeof detailsRaw !== 'object') return null

  const email = String(detailsRaw.email || '').trim()
  if (!email) return null

  return {
    requested: true,
    details: {
      email,
      company_name: detailsRaw.company_name
        ? String(detailsRaw.company_name)
        : detailsRaw.companyName
          ? String(detailsRaw.companyName)
          : undefined,
      vat_number: detailsRaw.vat_number
        ? String(detailsRaw.vat_number)
        : detailsRaw.vatNumber
          ? String(detailsRaw.vatNumber)
          : undefined,
      metadata:
        detailsRaw.metadata && typeof detailsRaw.metadata === 'object' && !Array.isArray(detailsRaw.metadata)
          ? (detailsRaw.metadata as Record<string, unknown>)
          : {},
    },
  }
}
