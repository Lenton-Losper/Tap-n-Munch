import { SettingsContent } from '@/components/settings/settings-content'
import { requireSettingsPermission } from '@/lib/settings/auth'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  await requireSettingsPermission(PERMISSIONS.SETTINGS_READ)
  return <SettingsContent />
}
