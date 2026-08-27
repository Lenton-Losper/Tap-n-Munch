'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, X } from 'lucide-react'
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
import { OrganizationStockItemSelectField } from '@/components/stock/organization-stock-item-select-field'
import { createTransferAction } from '@/lib/stock/transfer-actions'
import { isTransferableBetween } from '@/lib/stock/transfer-item-configuration'
import type { OrganizationRestaurantOption, OrganizationStockItemOption } from '@/lib/stock/transfer-queries'

type LineRow = {
  key: string
  organizationStockItemId: string
  quantity: string
}

function emptyRow(): LineRow {
  return { key: crypto.randomUUID(), organizationStockItemId: '', quantity: '' }
}

/**
 * THE DESTINATION PICKER IS EMPTY BECAUSE RLS SCOPED IT, NOT BECAUSE THE ORGANISATION HAS ONE SITE.
 *
 * `app/(staff)/stock/transfers/new/page.tsx:39` reads the organisation's locations through the
 * SESSION client, so `restaurants` RLS applies:
 *
 *     id IN (SELECT public.user_restaurant_ids()) OR owner_id = auth.uid()
 *
 * `organization_id` appears nowhere in that policy, so the list collapses to the locations the
 * caller is personally a `restaurant_users` member of. Measured against PRODUCTION on 2026-08-27:
 * Gosto Investment CC has three locations (Riviera, FNB ChowNow, Chownow Nedbank) and six distinct
 * staff users across them; FIVE OF THE SIX belong to exactly one of the three, so five of six open
 * this screen and get a blank destination picker. The sixth belongs to two and sees one of the
 * other two. Every one of them holds `stock:transfer_create` and reaches the screen.
 *
 * THE SCOPING IS THE RULING, NOT THE DEFECT. The owner's words: "a permission to create
 * cross-location transfers is not a permission to see every location in the organisation." So this
 * read stays session-scoped. What is wrong is the SILENCE — and, before this change, an assertion
 * that was flatly false for those five users: the screen said "There are no other locations in your
 * organization to transfer stock to yet" when there were two.
 *
 * DO NOT "FIX" THIS BY WIDENING THE READ. `resolveVisibleLocations` in lib/organizations/queries.ts
 * is the only sanctioned elevated path and it is gated on `authorizeOrganization(...,
 * 'view_all_locations')`, which is organisation-OWNER only. Applying it here would hand every
 * location's manager the whole estate, which is exactly the thing that was ruled out.
 *
 * A SECOND CASE EXISTS AND IS DELIBERATELY NOT BRANCHED ON. An organisation with a single location
 * produces the identical zero state, and on production most do (Mingle Brew & Pour alone has four
 * staff who reach this screen). For them "ask a manager for access" is a pointless errand; the true
 * answer is "your business only has one location". Separating the two needs the page to know how
 * many locations the organisation HAS, which is a count taken with RLS bypassed — a smaller thing
 * than listing them, but still an elevated read and therefore the owner's call, not this file's.
 * Logged for a ruling; until then both cases get the one message below.
 */
const NO_DESTINATIONS_COPY_PENDING = {
  /**
   * Placeholder, not drafted copy. MUST CONVEY, once signed off:
   *   1. stock can only be transferred to locations the reader themselves works at;
   *   2. the list is empty because the reader is not attached to any other location — this is a
   *      fact about their access, not a failure to load and not a fault in the system;
   *   3. what to do next: ask a manager for access to the other location.
   * MUST NOT read as an error, and MUST NOT imply that creating transfers is unavailable to this
   * person in general — they hold the permission; they simply have nowhere in range to send to.
   */
  body:
    'You can only transfer stock to locations you work at. If your business has other locations, ask a manager for access to the one you need to send stock to.',
}

export function CreateTransferForm({
  sourceRestaurantId,
  sourceRestaurantName,
  destinations,
  orgItems: initialOrgItems,
}: {
  sourceRestaurantId: string
  sourceRestaurantName: string
  destinations: OrganizationRestaurantOption[]
  orgItems: OrganizationStockItemOption[]
}) {
  const router = useRouter()
  const [orgItems, setOrgItems] = useState(initialOrgItems)
  const [toRestaurantId, setToRestaurantId] = useState(destinations[0]?.id ?? '')
  const [rows, setRows] = useState<LineRow[]>([emptyRow()])
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const destination = destinations.find((d) => d.id === toRestaurantId) ?? null

  /**
   * CHANGING THE DESTINATION RE-ASKS THE QUESTION THE PICKER ONLY ASKED ONCE.
   *
   * `OrganizationStockItemSelectField` blocks an item that is not configured at both ends AT THE
   * MOMENT IT IS PICKED. It cannot block one that became impossible AFTERWARDS, and the
   * destination is free to move after rows are filled in: pick an item mapped at destination B,
   * switch the destination to C where it is not mapped, and the row keeps a selection that
   * `dispatch_transfer` will reject with
   * `organization_stock_item % has no active stock_items mapping at destination restaurant %`.
   * Nothing between the picker and that exception looked at the pair again -- `handleSubmit`
   * filters on "has an id and a positive quantity" only, and `create_transfer` validates that the
   * two restaurants share an organisation but never that the ITEMS are mapped at both ends.
   *
   * So the selection is dropped rather than carried forward. The row returns to the picker, which
   * lists the same item with its existing "Not configured at {location}" affordance and its
   * existing tap-to-configure path -- one tap both re-selects the item and closes the gap that
   * made it impossible. No wording is introduced here on purpose: the recovery path is one the
   * component already owns.
   *
   * Rows with no selection yet, and rows whose item IS mapped at the new destination, are left
   * exactly as they are, quantity included.
   */
  const changeDestination = (nextToRestaurantId: string) => {
    setToRestaurantId(nextToRestaurantId)
    setRows((current) =>
      current.map((row) => {
        if (!row.organizationStockItemId) return row
        const orgItem = orgItems.find((item) => item.id === row.organizationStockItemId)
        if (orgItem && isTransferableBetween(orgItem, sourceRestaurantId, nextToRestaurantId)) {
          return row
        }
        return { ...row, organizationStockItemId: '' }
      }),
    )
  }

  const updateRow = (key: string, patch: Partial<LineRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const addRow = () => setRows((current) => [...current, emptyRow()])
  const removeRow = (key: string) =>
    setRows((current) => (current.length === 1 ? current : current.filter((row) => row.key !== key)))

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)

    if (!toRestaurantId) {
      setError('Choose a destination location.')
      return
    }

    const items = rows
      .filter((row) => row.organizationStockItemId && Number(row.quantity) > 0)
      .map((row) => {
        const orgItem = orgItems.find((item) => item.id === row.organizationStockItemId)
        return {
          organizationStockItemId: row.organizationStockItemId,
          quantitySent: Number(row.quantity),
          unitId: orgItem?.baseUnitId ?? '',
        }
      })

    if (items.length === 0) {
      setError('Add at least one item with a quantity greater than zero.')
      return
    }

    startTransition(async () => {
      const result = await createTransferAction({ toRestaurantId, items })
      if ('error' in result) {
        setError(result.error)
        return
      }
      router.push('/stock/transfers?created=1')
    })
  }

  if (destinations.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5 text-sm text-[#6B675F]">
        {NO_DESTINATIONS_COPY_PENDING.body}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
        <h2 className="font-serif text-xl font-semibold text-[#37352F]">Transfer details</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>From</Label>
            <p className="rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] px-3 py-2 text-sm text-[#37352F]">
              {sourceRestaurantName}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to-restaurant">To</Label>
            <Select value={toRestaurantId} onValueChange={changeDestination}>
              <SelectTrigger id="to-restaurant" className="w-full border-[#E9E9E7] bg-white">
                <SelectValue placeholder="Choose destination" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((restaurant) => (
                  <SelectItem key={restaurant.id} value={restaurant.id}>
                    {restaurant.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl font-semibold text-[#37352F]">Items to transfer</h2>
            <p className="mt-1 text-sm text-[#6B675F]">Add one row per item being sent.</p>
          </div>
          <Button type="button" variant="outline" onClick={addRow} className="border-[#E9E9E7]">
            <Plus className="mr-2 h-4 w-4" />
            Add item
          </Button>
        </div>

        <div className="mt-4 space-y-4">
          {rows.map((row, index) => (
            <div
              key={row.key}
              className="grid gap-3 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
            >
              <OrganizationStockItemSelectField
                orgItems={orgItems}
                onOrgItemsChange={setOrgItems}
                sourceRestaurantId={sourceRestaurantId}
                sourceRestaurantName={sourceRestaurantName}
                destinationRestaurantId={toRestaurantId || null}
                destinationRestaurantName={destination?.name ?? null}
                value={row.organizationStockItemId}
                onValueChange={(id) => updateRow(row.key, { organizationStockItemId: id })}
              />
              <div className="space-y-1.5">
                <Label htmlFor={`quantity-${row.key}`}>Quantity</Label>
                <Input
                  id={`quantity-${row.key}`}
                  type="number"
                  min="0"
                  step="any"
                  value={row.quantity}
                  onChange={(event) => updateRow(row.key, { quantity: event.target.value })}
                  className="border-[#E9E9E7] bg-white"
                />
              </div>
              <div className="flex items-end justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length === 1}
                  aria-label={`Remove item row ${index + 1}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={isPending} className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]">
          {isPending ? 'Saving...' : 'Save as Draft'}
        </Button>
        <Button type="button" variant="outline" className="border-[#E9E9E7]" asChild>
          <Link href="/stock/transfers">Cancel</Link>
        </Button>
      </div>
    </form>
  )
}
