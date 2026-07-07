import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { createBrowserClient } from '@supabase/ssr'

let _supabase: ReturnType<typeof createBrowserClient> | null = null
let _stagingBrowserAuthListenerRegistered = false
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim()

const isStagingDiag = () =>
  (process.env.NEXT_PUBLIC_APP_URL || '').includes('flashtap-staging')

export function getSupabaseClient() {
  if (!_supabase) {
    _supabase = createBrowserClient(supabaseUrl, supabaseAnonKey)
    // createBrowserClient has no built-in onAuthStateChange (unlike createServerClient).
    // Cookie sync runs via the SSR storage adapter on auth storage writes; this listener
    // surfaces the same GoTrue events that drive those writes, separate from AuthProvider.
    if (isStagingDiag() && !_stagingBrowserAuthListenerRegistered) {
      _stagingBrowserAuthListenerRegistered = true
      _supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
        console.log('[SUPABASE_BROWSER_CLIENT_AUTH]', {
          event,
          hasSession: !!session,
          timestamp: new Date().toISOString(),
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        })
      })
    }
  }
  return _supabase
}

export const supabase = getSupabaseClient();
