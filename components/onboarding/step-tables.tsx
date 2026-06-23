'use client'

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { getSupabaseTables } from '@/lib/supabase/tables'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import type { StepHandle } from './types'

type TableRow = {
  id: string
  table_number: number
  table_name?: string | null
}

type StepTablesProps = {
  restaurantId: string
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
}

export const StepTables = forwardRef<StepHandle, StepTablesProps>(function StepTables(
  { restaurantId, onError, setSaving },
  ref
) {
  const [count, setCount] = useState('4')
  const [existingTables, setExistingTables] = useState<TableRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const tables = await getSupabaseTables(restaurantId)
        if (!cancelled && tables?.length) {
          setExistingTables(tables as TableRow[])
          setCount(String(tables.length))
        }
      } catch {
        // ignore preload errors
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [restaurantId])

  useImperativeHandle(ref, () => ({
    save: async () => {
      const tableCount = Number(count)
      if (!Number.isFinite(tableCount) || tableCount < 1) {
        onError('Enter a valid number of tables (at least 1)')
        return false
      }

      setSaving(true)
      onError('')

      try {
        const payload = await onboardingFetch('/api/admin/tables/generate', {
          method: 'POST',
          body: JSON.stringify({ count: tableCount }),
        })
        setExistingTables(payload.tables || [])
        return true
      } catch (error: unknown) {
        onError(error instanceof Error ? error.message : 'Failed to create tables')
        return false
      } finally {
        setSaving(false)
      }
    },
  }))

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="tableCount">How many tables does your restaurant have?</Label>
        <Input
          id="tableCount"
          type="number"
          min={1}
          max={200}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          className="max-w-xs rounded-lg border-[#E9E9E7]"
        />
        <p className="text-sm text-[#6B675F]">You can add more later from your dashboard.</p>
      </div>

      {loading ? (
        <p className="text-sm text-[#6B675F]">Loading existing tables...</p>
      ) : existingTables.length > 0 ? (
        <div className="rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] p-4">
          <p className="text-sm font-medium text-[#37352F]">
            {existingTables.length} table{existingTables.length === 1 ? '' : 's'} already configured
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[#6B675F]">
            {existingTables.slice(0, 8).map((table) => (
              <li key={table.id}>
                {table.table_name || `Table ${table.table_number}`}
              </li>
            ))}
            {existingTables.length > 8 ? <li>+ {existingTables.length - 8} more</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  )
})
