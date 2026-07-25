import { supabase } from './client'

export async function signInWithGoogleOAuth(redirectParam?: string | null) {
  const callbackUrl = new URL('/auth/callback', window.location.origin)
  if (redirectParam) {
    callbackUrl.searchParams.set('redirect', redirectParam)
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: callbackUrl.toString(),
    },
  })
  if (error) throw error
}
