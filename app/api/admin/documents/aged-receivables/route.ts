import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { recomputeInvoiceStatus } from '@/lib/documents/recompute-status'

export const dynamic = 'force-dynamic'

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

function daysOverdue(dueDate: string): number {
  const dueMs = new Date(dueDate).getTime()
  const diff = Date.now() - dueMs
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)))
}

/**
 * Read-only: unpaid invoices already past their due_date, grouped by bill_to. Depends on
 * Part A's status/due_date/balance work (business_documents_status_payments migration) --
 * reuses documents:read, no new permission.
 */
export async function GET(request: Request) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const url = new URL(request.url)
    const restaurantIdParam = String(url.searchParams.get('restaurant_id') ?? '').trim()
    if (!restaurantIdParam) {
      return NextResponse.json({ error: 'restaurant_id query parameter is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, restaurantIdParam)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_READ)
    if (denied) return denied

    const nowIso = new Date().toISOString()
    const { data, error } = await supabase
      .from('business_documents')
      .select('id, document_number, bill_to, due_date, balance, status')
      .eq('restaurant_id', restaurantId)
      .eq('document_type', 'invoice')
      .in('status', ['sent', 'partially_paid', 'overdue'])
      .lt('due_date', nowIso)
      .order('due_date', { ascending: true })
    if (error) throw error

    const rows = data ?? []
    for (const row of rows) {
      const recomputed = await recomputeInvoiceStatus(supabase, String(row.id))
      row.balance = recomputed.balance
      row.status = recomputed.status
    }

    const lines = rows
      .filter((row) => Number(row.balance) > 0)
      .map((row) => {
        const billTo =
          row.bill_to && typeof row.bill_to === 'object' && !Array.isArray(row.bill_to)
            ? (row.bill_to as Record<string, unknown>)
            : null
        return {
          id: row.id,
          document_number: row.document_number,
          bill_to: billTo ? String(billTo.name ?? '').trim() || 'Unknown' : 'Unknown',
          due_date: row.due_date,
          balance: Number(row.balance),
          days_overdue: daysOverdue(String(row.due_date)),
        }
      })

    const byCustomer = new Map<string, { customer: string; balance: number; invoiceCount: number; maxDaysOverdue: number }>()
    for (const line of lines) {
      const existing = byCustomer.get(line.bill_to)
      if (existing) {
        existing.balance += line.balance
        existing.invoiceCount += 1
        existing.maxDaysOverdue = Math.max(existing.maxDaysOverdue, line.days_overdue)
      } else {
        byCustomer.set(line.bill_to, {
          customer: line.bill_to,
          balance: line.balance,
          invoiceCount: 1,
          maxDaysOverdue: line.days_overdue,
        })
      }
    }

    const byCustomerList = [...byCustomer.values()].sort((a, b) => b.balance - a.balance)
    const totalOutstanding = lines.reduce((sum, line) => sum + line.balance, 0)

    return NextResponse.json({ invoices: lines, byCustomer: byCustomerList, totalOutstanding })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load aged receivables'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
