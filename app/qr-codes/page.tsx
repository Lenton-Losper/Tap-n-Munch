import { QRCodeManagement } from "@/components/qr-code-management"
import { ProtectedRoute } from "@/components/auth/protected-route"

export default function QRCodesPage() {
  return (
    <ProtectedRoute>
      <QRCodeManagement />
    </ProtectedRoute>
  )
}
