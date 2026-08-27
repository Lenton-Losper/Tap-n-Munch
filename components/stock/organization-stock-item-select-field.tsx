'use client'

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ConfigureCanonicalItemDialog,
  type ConfigureCanonicalItemTarget,
} from '@/components/stock/configure-canonical-item-dialog'
import { unconfiguredTransferEnd } from '@/lib/stock/transfer-item-configuration'
import type { OrganizationStockItemOption } from '@/lib/stock/transfer-queries'

export function OrganizationStockItemSelectField({
  orgItems,
  onOrgItemsChange,
  sourceRestaurantId,
  sourceRestaurantName,
  destinationRestaurantId,
  destinationRestaurantName,
  value,
  onValueChange,
  disabled = false,
}: {
  orgItems: OrganizationStockItemOption[]
  onOrgItemsChange: (items: OrganizationStockItemOption[]) => void
  sourceRestaurantId: string
  sourceRestaurantName: string
  destinationRestaurantId: string | null
  destinationRestaurantName: string | null
  value: string
  onValueChange: (organizationStockItemId: string) => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [configureTarget, setConfigureTarget] = useState<ConfigureCanonicalItemTarget | null>(null)
  const [configureOpen, setConfigureOpen] = useState(false)

  const selected = orgItems.find((item) => item.id === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...orgItems].sort((a, b) => a.name.localeCompare(b.name))
    if (!q) return sorted
    return sorted.filter((item) => item.name.toLowerCase().includes(q))
  }, [query, orgItems])

  const missingLocationFor = (item: OrganizationStockItemOption): ConfigureCanonicalItemTarget | null => {
    // The destination is only offered to the shared predicate when its NAME is also known,
    // because the target this builds must be able to name the location it wants configured.
    // A destination we cannot name is reported as "nothing missing" rather than as an
    // unnameable gap -- which is the behaviour this had before the predicate was extracted.
    const nameableDestinationId =
      destinationRestaurantId && destinationRestaurantName ? destinationRestaurantId : null
    const end = unconfiguredTransferEnd(item, sourceRestaurantId, nameableDestinationId)
    if (end === null) return null

    const missingAt =
      end === 'SOURCE'
        ? { restaurantId: sourceRestaurantId, restaurantName: sourceRestaurantName }
        : { restaurantId: destinationRestaurantId as string, restaurantName: destinationRestaurantName as string }

    return {
      organizationStockItemId: item.id,
      itemName: item.name,
      baseUnitId: item.baseUnitId,
      baseUnitLabel: item.baseUnitLabel,
      ...missingAt,
    }
  }

  const handlePick = (item: OrganizationStockItemOption) => {
    const missing = missingLocationFor(item)
    if (missing) {
      // Never silently select an unconfigured item -- block and offer the configure path.
      setConfigureTarget(missing)
      setConfigureOpen(true)
      setOpen(false)
      return
    }
    onValueChange(item.id)
    setQuery(item.name)
    setOpen(false)
  }

  return (
    <>
      <div className="relative space-y-1.5">
        <Label>Item</Label>
        <Input
          value={open ? query : (selected?.name ?? '')}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setQuery(selected?.name ?? '')
            setOpen(true)
          }}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150)
          }}
          placeholder="Search items..."
          className="border-[#E9E9E7] bg-white"
          disabled={disabled}
        />
        {open && !disabled ? (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-[#E9E9E7] bg-white shadow-md">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[#6B675F]">No items match your search.</p>
            ) : (
              filtered.map((item) => {
                const missing = missingLocationFor(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-[#FAFAF8]"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handlePick(item)}
                  >
                    <span className="font-medium text-[#37352F]">{item.name}</span>
                    {missing ? (
                      <span className="text-xs text-amber-700">
                        Not configured at {missing.restaurantName} — tap to configure
                      </span>
                    ) : (
                      <span className="text-xs text-[#6B675F]">{item.baseUnitLabel}</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        ) : null}
      </div>

      <ConfigureCanonicalItemDialog
        target={configureTarget}
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        onConfigured={(target) => {
          onOrgItemsChange(
            orgItems.map((item) =>
              item.id === target.organizationStockItemId
                ? { ...item, configuredRestaurantIds: [...item.configuredRestaurantIds, target.restaurantId] }
                : item,
            ),
          )
        }}
      />
    </>
  )
}
