'use server'

import { revalidatePath } from 'next/cache'
import { requireSettingsPermissionOrError } from '@/lib/settings/auth'
import { requireMenuPermissionOrError } from '@/lib/menu/auth'
import { requireDocumentsPermissionOrError } from '@/lib/documents/auth'
import { PERMISSIONS } from '@/lib/permissions'
import { getTaxRatesForRestaurant } from '@/lib/tax-rates/queries'
import type { TaxRateOption } from '@/lib/tax-rates/format'

function revalidateTaxRatePaths() {
  revalidatePath('/settings')
  revalidatePath('/menu-management')
  revalidatePath('/documents')
}

export async function getTaxRatesAction(): Promise<
  { data: TaxRateOption[] } | { error: string }
> {
  const context = await requireSettingsPermissionOrError(PERMISSIONS.SETTINGS_READ)
  if ('error' in context) return context

  try {
    const data = await getTaxRatesForRestaurant(context.supabase, context.restaurantId)
    return { data }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to load tax rates.' }
  }
}

export async function getTaxRatesForMenuFormAction(): Promise<
  { data: TaxRateOption[] } | { error: string }
> {
  const context = await requireMenuPermissionOrError(PERMISSIONS.MENU_READ)
  if ('error' in context) return context

  try {
    const data = await getTaxRatesForRestaurant(context.supabase, context.restaurantId)
    return { data }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to load tax rates.' }
  }
}

export async function getTaxRatesForDocumentFormAction(): Promise<
  { data: TaxRateOption[] } | { error: string }
> {
  const context = await requireDocumentsPermissionOrError(PERMISSIONS.DOCUMENTS_READ)
  if ('error' in context) return context

  try {
    const data = await getTaxRatesForRestaurant(context.supabase, context.restaurantId)
    return { data }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to load tax rates.' }
  }
}

export type CreateTaxRateInput = {
  name: string
  percentage: number
  isInclusive: boolean
  isDefault: boolean
}

export async function createTaxRateAction(
  input: CreateTaxRateInput,
): Promise<{ data: TaxRateOption } | { error: string }> {
  const context = await requireSettingsPermissionOrError(PERMISSIONS.SETTINGS_WRITE)
  if ('error' in context) return context

  const name = input.name.trim()
  if (!name) {
    return { error: 'Tax rate name is required.' }
  }
  if (!Number.isFinite(input.percentage) || input.percentage < 0) {
    return { error: 'Percentage must be a non-negative number.' }
  }

  const { supabase, restaurantId } = context

  if (input.isDefault) {
    const { error: clearError } = await supabase
      .from('tax_rates')
      .update({ is_default: false })
      .eq('restaurant_id', restaurantId)
      .eq('is_default', true)
    if (clearError) return { error: clearError.message }
  }

  const { data, error } = await supabase
    .from('tax_rates')
    .insert({
      restaurant_id: restaurantId,
      name,
      percentage: input.percentage,
      is_inclusive: input.isInclusive,
      is_default: input.isDefault,
    })
    .select('id, name, percentage, is_inclusive, is_default')
    .single()

  if (error) return { error: error.message }

  revalidateTaxRatePaths()
  return {
    data: {
      id: data.id,
      name: data.name,
      percentage: Number(data.percentage),
      is_inclusive: data.is_inclusive,
      is_default: data.is_default,
    },
  }
}

export type UpdateTaxRateInput = {
  id: string
  name: string
  percentage: number
  isInclusive: boolean
}

export async function updateTaxRateAction(
  input: UpdateTaxRateInput,
): Promise<{ data: true } | { error: string }> {
  const context = await requireSettingsPermissionOrError(PERMISSIONS.SETTINGS_WRITE)
  if ('error' in context) return context

  const name = input.name.trim()
  if (!name) {
    return { error: 'Tax rate name is required.' }
  }
  if (!Number.isFinite(input.percentage) || input.percentage < 0) {
    return { error: 'Percentage must be a non-negative number.' }
  }

  const { error } = await context.supabase
    .from('tax_rates')
    .update({ name, percentage: input.percentage, is_inclusive: input.isInclusive })
    .eq('id', input.id)
    .eq('restaurant_id', context.restaurantId)

  if (error) return { error: error.message }

  revalidateTaxRatePaths()
  return { data: true }
}

export async function setDefaultTaxRateAction(
  id: string,
): Promise<{ data: true } | { error: string }> {
  const context = await requireSettingsPermissionOrError(PERMISSIONS.SETTINGS_WRITE)
  if ('error' in context) return context

  const { supabase, restaurantId } = context

  const { error: clearError } = await supabase
    .from('tax_rates')
    .update({ is_default: false })
    .eq('restaurant_id', restaurantId)
    .eq('is_default', true)
  if (clearError) return { error: clearError.message }

  const { error } = await supabase
    .from('tax_rates')
    .update({ is_default: true })
    .eq('id', id)
    .eq('restaurant_id', restaurantId)

  if (error) return { error: error.message }

  revalidateTaxRatePaths()
  return { data: true }
}

export async function deleteTaxRateAction(
  id: string,
): Promise<{ data: true } | { error: string }> {
  const context = await requireSettingsPermissionOrError(PERMISSIONS.SETTINGS_WRITE)
  if ('error' in context) return context

  const { error } = await context.supabase
    .from('tax_rates')
    .delete()
    .eq('id', id)
    .eq('restaurant_id', context.restaurantId)

  if (error) return { error: error.message }

  revalidateTaxRatePaths()
  return { data: true }
}
