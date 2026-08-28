'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Trash2, Plus } from 'lucide-react'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import type { RestaurantRoleOption } from '@/components/staff/restaurant-roles-client'

type Row = {
  name: string
  role: string
  pin: string
}

type RowResult = {
  name: string
  ok: boolean
  error?: string
}

function emptyRow(defaultRole: string): Row {
  return { name: '', role: defaultRole, pin: '' }
}

type BulkAddStaffDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  assignableRoles: RestaurantRoleOption[]
  onCreated: () => void
}

export function BulkAddStaffDialog({
  open,
  onOpenChange,
  assignableRoles,
  onCreated,
}: BulkAddStaffDialogProps) {
  const defaultRole = assignableRoles[0]?.role_slug ?? ''
  const [rows, setRows] = useState<Row[]>([emptyRow(defaultRole)])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<RowResult[] | null>(null)

  const reset = () => {
    setRows([emptyRow(defaultRole)])
    setError(null)
    setResults(null)
  }

  const updateRow = (index: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const addRow = () => setRows((prev) => [...prev, emptyRow(defaultRole)])

  const removeRow = (index: number) =>
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))

  const validRows = rows.filter((r) => r.name.trim() && r.role && /^[0-9]{4}$/.test(r.pin))
  const canSubmit = validRows.length === rows.length && rows.length > 0 && !submitting

  const handleSubmit = async () => {
    setSubmitting(true)
    setError(null)
    setResults(null)
    try {
      const payload = await onboardingFetch('/api/admin/staff/bulk-create', {
        method: 'POST',
        body: JSON.stringify({
          staff: rows.map((r) => ({ name: r.name.trim(), role: r.role, pin: r.pin })),
        }),
      })
      const rowResults = (payload.results ?? []) as RowResult[]
      setResults(rowResults)
      if (payload.created_count > 0) onCreated()
      if (payload.failed_count === 0) {
        onOpenChange(false)
        reset()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add staff. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add staff without email</DialogTitle>
          <DialogDescription>
            For a waiter or anyone else with no work email. Set their PIN now so they can sign in
            on the terminal right away.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-80 overflow-y-auto">
          {rows.map((row, index) => (
            <div key={index} className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                {index === 0 && <Label className="text-xs">Name</Label>}
                <Input
                  value={row.name}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                  placeholder="e.g., Maria"
                />
              </div>
              <div className="w-28 shrink-0">
                {index === 0 && <Label className="text-xs">Role</Label>}
                <Select value={row.role} onValueChange={(value) => updateRow(index, { role: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((role) => (
                      <SelectItem key={role.role_slug} value={role.role_slug}>
                        {role.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-20 shrink-0">
                {index === 0 && <Label className="text-xs">PIN</Label>}
                <Input
                  value={row.pin}
                  onChange={(e) =>
                    updateRow(index, { pin: e.target.value.replace(/\D/g, '').slice(0, 4) })
                  }
                  placeholder="1234"
                  inputMode="numeric"
                  maxLength={4}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-gray-400 hover:text-red-500 shrink-0"
                onClick={() => removeRow(index)}
                disabled={rows.length === 1}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <Button type="button" variant="outline" size="sm" onClick={addRow} className="self-start">
          <Plus className="w-4 h-4 mr-2" />
          Add another
        </Button>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {results && results.some((r) => !r.ok) && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm space-y-1">
            <p className="font-medium text-amber-900">
              {results.filter((r) => r.ok).length} added, {results.filter((r) => !r.ok).length}{' '}
              did not go through:
            </p>
            {results
              .filter((r) => !r.ok)
              .map((r, i) => (
                <p key={i} className="text-amber-800">
                  {r.name}: {r.error}
                </p>
              ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting
              ? 'Adding…'
              : `Add ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
