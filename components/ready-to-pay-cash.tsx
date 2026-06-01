'use client'

import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase/client'

type Props = {
  orderId: string
  className?: string
}

const NOTIFIED_MESSAGE = 'Staff has been notified. They will be with you shortly.'

/**
 * Customer CTA for cash orders: notify staff the customer is ready to pay.
 */
export function ReadyToPayCashButton({ orderId, className }: Props) {
  const [loading, setLoading] = useState(false)
  const [notified, setNotified] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (notified) {
    return (
      <p
        className={`flex items-center justify-center gap-2 text-sm font-sans font-medium text-green-700 dark:text-green-400 ${className ?? ''}`}
        role="status"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        {NOTIFIED_MESSAGE}
      </p>
    )
  }

  return (
    <div className={className}>
      {error && (
        <p className="text-sm text-destructive font-sans mb-2 text-center" role="alert">
          {error}
        </p>
      )}
      <Button
        type="button"
        className="w-full bg-green-600 text-white hover:bg-green-700 font-sans font-semibold text-base py-6"
        disabled={loading}
        onClick={async () => {
          if (loading) return
          setError(null)
          setLoading(true)
          try {
            const { error: updateError } = await supabase
              .from('orders')
              .update({ customer_ready_to_pay: true })
              .eq('id', orderId)

            if (updateError) {
              throw updateError
            }
            setNotified(true)
          } catch {
            setError('Something went wrong. Please try again.')
            setLoading(false)
          }
        }}
      >
        {loading ? 'Sending…' : 'Ready to Pay'}
      </Button>
    </div>
  )
}

export function ReadyToPayCashNotified({ className }: { className?: string }) {
  return (
    <p
      className={`flex items-center justify-center gap-2 text-sm font-sans font-medium text-green-700 dark:text-green-400 ${className ?? ''}`}
      role="status"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      {NOTIFIED_MESSAGE}
    </p>
  )
}
