import { createServerSupabaseClient } from './server'

export async function createSupabaseUser(data: {
  id: string
  email: string
  name: string
  phone: string
  role?: string
}) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('users')
    .insert({
      id: data.id,
      email: data.email,
      name: data.name,
      phone: data.phone,
      role: data.role || 'owner',
    })
  if (error) throw error
}

export async function getSupabaseUser(userId: string) {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('users')
    .select('*, restaurants(*)')
    .eq('id', userId)
    .single()
  if (error) throw error
  return data
}
