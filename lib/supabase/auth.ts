import { supabase } from './client'

export async function signUpWithSupabase(
  email: string,
  password: string,
  name: string,
  phone: string
) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name, phone },
    },
  })
  if (error) throw error
  return data
}

export async function signInWithSupabase(
  email: string,
  password: string
) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })
  if (error) throw error
  return data
}

export async function signOutSupabase() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function getSupabaseSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export function onSupabaseAuthChange(
  callback: (event: string, session: any) => void
) {
  return supabase.auth.onAuthStateChange((event: string, session) => {
    callback(event, session)
  })
}

export async function getSupabaseUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  return data.user
}
