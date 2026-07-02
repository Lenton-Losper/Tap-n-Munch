import { redirect } from 'next/navigation'

export default function StockRecipesRedirectPage() {
  redirect('/menu-management?missingInventory=true')
}
