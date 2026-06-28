'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getSession().then((result: any) => {
      const session = result.data.session
      if (!session) {
        router.replace('/signin')
      }
    })
  }, [router])

  return <>{children}</>
}
