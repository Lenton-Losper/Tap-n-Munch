import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { resolveUserContexts } from '@/lib/auth/resolve-user-contexts'
import { OpsLayoutClient } from '@/components/platform/ops-layout-client'

export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/signin')
  }

  let contexts
  try {
    contexts = await resolveUserContexts(user.id)
  } catch {
    redirect('/signin')
  }

  if (!contexts.some((c) => c.type === 'platform')) {
    redirect('/signin')
  }

  return <OpsLayoutClient>{children}</OpsLayoutClient>
}
