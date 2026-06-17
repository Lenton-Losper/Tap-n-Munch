'use client'

import { useEffect } from 'react'
import { QrCode } from 'lucide-react'

export default function SessionEndedPage() {
  useEffect(() => {
    console.log('[SESSION-ENDED] page mounted, URL:', window.location.href)
    console.log('[SESSION-ENDED] localStorage token:', localStorage.getItem('flashtap_session_token'))
    console.log('[SESSION-ENDED] localStorage tab:', localStorage.getItem('flashtap_tab_id'))
  }, [])

  useEffect(() => {
    // Clear everything when this page loads
    sessionStorage.removeItem('flashtap_session_token')
    localStorage.removeItem('flashtap_session_token')
    localStorage.removeItem('flashtap_tab_id')
    localStorage.removeItem('flashtap_table')
    sessionStorage.removeItem('flashtap_session_expired')
    // Prevent any back navigation
    window.history.pushState(null, '', window.location.href)
    window.onpopstate = () => {
      window.history.pushState(null, '', window.location.href)
    }
  }, [])

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center">
        <QrCode className="w-8 h-8 text-white/60" />
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-white font-sans">
          Your dining session has ended
        </h1>
        <p className="text-sm text-white/60 max-w-xs font-sans leading-relaxed">
          Please scan the QR code on your table to start a new order.
        </p>
      </div>
    </div>
  )
}
