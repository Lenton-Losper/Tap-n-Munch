'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { TaxInvoiceFormValues } from '@/lib/invoices/invoice-preference'

type Props = {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  values: TaxInvoiceFormValues
  onChange: (values: TaxInvoiceFormValues) => void
  showFnbFields: boolean
  disabled?: boolean
}

function Field({
  id,
  label,
  value,
  onChange,
  disabled,
  required,
  type = 'text',
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  required?: boolean
  type?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="font-sans text-sm">
        {label}
        {required ? ' *' : ''}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="font-sans"
      />
    </div>
  )
}

export function TaxInvoiceRequestFields({
  enabled,
  onEnabledChange,
  values,
  onChange,
  showFnbFields,
  disabled,
}: Props) {
  const setField = (key: keyof TaxInvoiceFormValues, value: string) => {
    onChange({ ...values, [key]: value })
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-sans text-sm font-semibold text-foreground">Need a company tax invoice?</p>
          <p className="mt-1 font-sans text-xs text-muted-foreground">
            We will email your tax invoice after payment is completed.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          disabled={disabled}
          aria-label="Need a company tax invoice?"
        />
      </div>

      {enabled ? (
        <div className="space-y-3 border-t border-border pt-4">
          <Field
            id="tax-invoice-email"
            label="Invoice email"
            type="email"
            value={values.email}
            onChange={(value) => setField('email', value)}
            disabled={disabled}
            required
          />
          <Field
            id="tax-invoice-company"
            label="Company name"
            value={values.companyName}
            onChange={(value) => setField('companyName', value)}
            disabled={disabled}
          />
          <Field
            id="tax-invoice-vat"
            label="VAT number"
            value={values.vatNumber}
            onChange={(value) => setField('vatNumber', value)}
            disabled={disabled}
          />

          {showFnbFields ? (
            <>
              <Field
                id="tax-invoice-department"
                label="Department"
                value={values.department}
                onChange={(value) => setField('department', value)}
                disabled={disabled}
              />
              <Field
                id="tax-invoice-gl"
                label="GL number"
                value={values.glNumber}
                onChange={(value) => setField('glNumber', value)}
                disabled={disabled}
              />
              <Field
                id="tax-invoice-employee"
                label="Employee code"
                value={values.employeeCode}
                onChange={(value) => setField('employeeCode', value)}
                disabled={disabled}
              />
              <Field
                id="tax-invoice-cost-centre"
                label="Cost centre"
                value={values.costCentre}
                onChange={(value) => setField('costCentre', value)}
                disabled={disabled}
              />
              <Field
                id="tax-invoice-business-unit"
                label="Business unit"
                value={values.businessUnit}
                onChange={(value) => setField('businessUnit', value)}
                disabled={disabled}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
