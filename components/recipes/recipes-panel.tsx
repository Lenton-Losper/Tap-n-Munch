'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { RecipesOverviewData } from '@/lib/recipes/queries'

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-[#6B675F]">{label}</p>
      <p className="mt-2 font-serif text-3xl font-semibold text-[#37352F]">{value}</p>
    </div>
  )
}

export function RecipesPanel({
  data,
  canEdit,
}: {
  data: RecipesOverviewData
  canEdit: boolean
}) {
  const [search, setSearch] = useState('')

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return data.rows
    return data.rows.filter((row) => row.name.toLowerCase().includes(query))
  }, [data.rows, search])

  return (
    <div className="space-y-6">
      <SummaryCard
        label="Recipe coverage"
        value={`${data.withRecipe} / ${data.total} menu items`}
      />

      <div className="rounded-2xl border border-[#E9E9E7] bg-white">
        <div className="border-b border-[#E9E9E7] px-5 py-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-serif text-xl font-semibold text-[#37352F]">Menu items</h2>
              <p className="mt-1 text-sm text-[#6B675F]">
                Link ingredients to menu items for automatic stock deduction on sale.
              </p>
            </div>
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6B675F]" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by item name"
                className="border-[#E9E9E7] pl-9"
              />
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
              <tr>
                <th className="px-5 py-3">Item</th>
                <th className="px-5 py-3">Category</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-[#6B675F]">
                    {data.rows.length === 0
                      ? 'No active menu items yet.'
                      : 'No items match your search.'}
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr key={row.menuItemId} className="border-t border-[#E9E9E7]">
                    <td className="px-5 py-3 font-medium text-[#37352F]">{row.name}</td>
                    <td className="px-5 py-3 text-[#6B675F]">{row.categoryName}</td>
                    <td className="px-5 py-3">
                      {row.hasRecipe ? (
                        <Badge className="border-green-200 bg-green-50 text-green-800">Has recipe</Badge>
                      ) : (
                        <Badge variant="outline" className="border-[#E9E9E7] text-[#6B675F]">
                          No recipe
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="border-[#E9E9E7]"
                        asChild
                      >
                        <Link href={`/stock/recipes/${row.menuItemId}`}>
                          {canEdit ? 'Edit' : 'View'}
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
