export const dynamic = "force-dynamic";

import { ProtectedRoute } from "@/components/auth/protected-route"

export default function AnalyticsPage() {
  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-[#F7F6F3] px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-2xl border border-[#E9E9E7] bg-white p-8 text-center shadow-sm">
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Analytics</h1>
            <p className="mt-3 text-base text-[#6B675F]">
              This page is not available yet.
            </p>
            <p className="mt-1 text-sm text-[#8A867E]">
              We are preparing reporting features for a future release.
            </p>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  )
}
