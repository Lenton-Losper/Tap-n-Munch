import { redirect } from 'next/navigation'

type RecipeEditorRedirectProps = {
  params: Promise<{ menuItemId: string }>
}

export default async function StockRecipeEditorRedirectPage(_props: RecipeEditorRedirectProps) {
  redirect('/menu-management?missingInventory=true')
}
