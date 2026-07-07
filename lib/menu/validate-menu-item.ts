export interface MenuItemDraft {
  itemId?: string | null
  name: string
  subCategoryId: string | null
  categoryId: string | null
  ingredientRows: Array<{ stockItemId: string; quantity: string | number; unitId: string }>
}

export interface ExistingMenuItem {
  id: string
  name: string
  subCategoryId: string | null
  categoryId: string | null
}

export interface ValidationResult {
  blockingErrors: string[]
  normalizedIngredients: Array<{ stockItemId: string; quantity: number; unitId: string }>
}

const INCOMPLETE_INGREDIENT_ERROR =
  'An ingredient row is incomplete — please finish or remove it.'

function hasText(value: string | null | undefined): boolean {
  return String(value ?? '').trim() !== ''
}

function hasQuantityValue(quantity: string | number | null | undefined): boolean {
  if (quantity === null || quantity === undefined) return false
  if (typeof quantity === 'string' && quantity.trim() === '') return false
  return true
}

function parsePositiveQuantity(quantity: string | number): number | null {
  const parsed = typeof quantity === 'number' ? quantity : Number(quantity)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function isIngredientRowEmpty(row: MenuItemDraft['ingredientRows'][number]): boolean {
  return (
    !hasText(row.stockItemId) &&
    !hasQuantityValue(row.quantity) &&
    !hasText(row.unitId)
  )
}

function isIngredientRowComplete(row: MenuItemDraft['ingredientRows'][number]): boolean {
  const quantity = parsePositiveQuantity(row.quantity)
  return hasText(row.stockItemId) && hasText(row.unitId) && quantity !== null
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function isSameMenuScope(
  draft: MenuItemDraft,
  existing: ExistingMenuItem,
): boolean {
  if (draft.subCategoryId) {
    return existing.subCategoryId === draft.subCategoryId
  }
  return existing.categoryId === draft.categoryId
}

export function validateMenuItemDraft(
  draft: MenuItemDraft,
  existingItems: ExistingMenuItem[],
): ValidationResult {
  const blockingErrors: string[] = []
  const normalizedIngredients: ValidationResult['normalizedIngredients'] = []

  const trimmedName = draft.name.trim()
  const normalizedDraftName = normalizeName(trimmedName)

  if (trimmedName) {
    const duplicate = existingItems.find((existing) => {
      if (draft.itemId && existing.id === draft.itemId) return false
      if (!isSameMenuScope(draft, existing)) return false
      return normalizeName(existing.name) === normalizedDraftName
    })

    if (duplicate) {
      blockingErrors.push(`An item named "${trimmedName}" already exists in this category.`)
    }
  }

  for (const row of draft.ingredientRows) {
    if (isIngredientRowEmpty(row)) {
      continue
    }

    if (isIngredientRowComplete(row)) {
      const quantity = parsePositiveQuantity(row.quantity)!
      normalizedIngredients.push({
        stockItemId: String(row.stockItemId).trim(),
        quantity,
        unitId: String(row.unitId).trim(),
      })
      continue
    }

    blockingErrors.push(INCOMPLETE_INGREDIENT_ERROR)
  }

  return { blockingErrors, normalizedIngredients }
}
