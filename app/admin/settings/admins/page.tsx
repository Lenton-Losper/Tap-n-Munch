import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/platform/ops-shell'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { AddPlatformAdminForm } from '../../platform-admins/add-admin-form'

export const dynamic = 'force-dynamic'

type PlatformAdminRow = {
  id: string
  email: string
  role: string
  created_at: string
}

async function loadAdmins(): Promise<PlatformAdminRow[]> {
  const supabase = createServerSupabaseClient()
  const { data } = await supabase
    .from('platform_admins')
    .select('id, email, role, created_at')
    .order('created_at', { ascending: true })
  return data || []
}

export default async function AdminSettingsPage() {
  const admins = await loadAdmins()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">
          Platform admins
        </h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Manage who can access the FlashTap Ops Console.
        </p>
      </div>

      <section className="rounded-xl border border-[#E8E6E1] bg-white p-5">
        <h2 className="text-sm font-semibold text-[#1A1A1A]">Add administrator</h2>
        <p className="mt-1 text-sm text-[#8A867C]">
          The user must already have a FlashTap account.
        </p>
        <div className="mt-4">
          <AddPlatformAdminForm />
        </div>
      </section>

      {admins.length === 0 ? (
        <EmptyState title="No platform admins" body="Add the first administrator above." />
      ) : (
        <section className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
          <div className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Administrators</h2>
            <span className="text-xs text-[#8A867C]">{admins.length} total</span>
          </div>
          <ul className="divide-y divide-[#EFEDE8]">
            {admins.map((admin) => (
              <li key={admin.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-[#1A1A1A]">{admin.email}</div>
                  <div className="mt-0.5 text-xs text-[#8A867C]">
                    Added {new Date(admin.created_at).toLocaleDateString('en-NA')}
                  </div>
                </div>
                <Badge variant="outline" className="border-[#E8E6E1] text-[#5C574E]">
                  {admin.role.replace(/_/g, ' ')}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
