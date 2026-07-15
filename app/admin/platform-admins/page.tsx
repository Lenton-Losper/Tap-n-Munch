import Link from 'next/link'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { AddPlatformAdminForm } from './add-admin-form'

export const dynamic = 'force-dynamic'

type PlatformAdminRow = {
  id: string
  email: string
  role: string
  created_at: string
}

function formatDate(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-NA', { year: 'numeric', month: 'short', day: 'numeric' })
}

async function loadAdmins(): Promise<PlatformAdminRow[]> {
  const supabase = createServerSupabaseClient()
  const { data } = await supabase
    .from('platform_admins')
    .select('id, email, role, created_at')
    .order('created_at', { ascending: true })
  return data ?? []
}

export default async function PlatformAdminsPage() {
  const admins = await loadAdmins()

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/admin/restaurants"
            className="text-sm font-medium text-[#2E75B6] hover:underline"
          >
            ← Back to restaurants
          </Link>
          <h1 className="mt-4 font-serif text-3xl font-semibold text-[#37352F]">
            Platform Admins
          </h1>
          <p className="mt-1 text-sm text-[#6B675F]">
            {admins.length} platform admin{admins.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-[#37352F]">Add platform admin</h2>
          <div className="mt-4">
            <AddPlatformAdminForm />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-[#E9E9E7] bg-white">
          <div className="divide-y divide-[#F1F0EC]">
            {admins.length === 0 && (
              <p className="p-6 text-center text-sm text-[#6B675F]">No platform admins yet.</p>
            )}
            {admins.map((admin) => (
              <div key={admin.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium text-[#37352F]">{admin.email}</p>
                  <p className="text-xs text-[#6B675F]">Added {formatDate(admin.created_at)}</p>
                </div>
                <span className="inline-flex items-center rounded-full bg-[#EBF3FB] px-2.5 py-0.5 text-xs font-medium capitalize text-[#2E75B6]">
                  {admin.role.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
