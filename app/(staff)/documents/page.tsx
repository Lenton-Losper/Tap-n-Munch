export const dynamic = 'force-dynamic'

import { DocumentsListContent } from '@/components/documents/documents-list-content'
import { requireDocumentsPermission } from '@/lib/documents/auth'
import { PERMISSIONS } from '@/lib/permissions'

export default async function DocumentsPage() {
  await requireDocumentsPermission(PERMISSIONS.DOCUMENTS_READ)
  return <DocumentsListContent />
}
