'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'

export default function FlashTapPayCheckoutPage() {
  const searchParams = useSearchParams()
  const merchant = searchParams.get('merchant') || 'FlashTap Merchant'
  const amount = searchParams.get('amount') || '0.00'
  const note = searchParams.get('note') || ''
  const [cardNo, setCardNo] = useState('')
  const [cardHolder, setCardHolder] = useState('')
  const [expiryMonth, setExpiryMonth] = useState('')
  const [expiryYear, setExpiryYear] = useState('')
  const [cvv, setCvv] = useState('')
  const [processing, setProcessing] = useState(false)
  const [message, setMessage] = useState('')

  const payNow = async () => {
    setProcessing(true)
    setMessage('')
    try {
      const res = await fetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantName: merchant,
          amount: Number(amount),
          note,
          card: {
            cardNo,
            cardHolder: cardHolder || merchant,
            expireMonth: expiryMonth,
            expireYear: expiryYear,
            cvv,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Payment failed')
      setMessage(`Payment submitted. Status: ${data.paymentStatus || 'processing'}`)
    } catch (error: any) {
      setMessage(`Payment failed: ${error.message}`)
    } finally {
      setProcessing(false)
    }
  }

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-6">
      <section className="w-full max-w-md border bg-card p-6 space-y-4">
        <h1 className="text-2xl font-bold">FlashTap Pay</h1>
        <p className="text-sm text-muted-foreground">Instant payment checkout</p>

        <div className="border p-4 space-y-2">
          <p className="text-sm text-muted-foreground">Merchant</p>
          <p className="font-semibold">{merchant}</p>
          <p className="text-sm text-muted-foreground">Amount</p>
          <p className="text-2xl font-bold">N${amount}</p>
          {note && (
            <>
              <p className="text-sm text-muted-foreground">Note</p>
              <p>{note}</p>
            </>
          )}
        </div>

        <input className="w-full border p-2" placeholder="Card number" value={cardNo} onChange={(e) => setCardNo(e.target.value)} />
        <input className="w-full border p-2" placeholder="Card holder" value={cardHolder} onChange={(e) => setCardHolder(e.target.value)} />
        <div className="grid grid-cols-3 gap-2">
          <input className="w-full border p-2" placeholder="MM" value={expiryMonth} onChange={(e) => setExpiryMonth(e.target.value)} />
          <input className="w-full border p-2" placeholder="YYYY" value={expiryYear} onChange={(e) => setExpiryYear(e.target.value)} />
          <input className="w-full border p-2" placeholder="CVV" value={cvv} onChange={(e) => setCvv(e.target.value)} />
        </div>
        <button
          onClick={payNow}
          disabled={processing}
          className="block w-full text-center border px-4 py-3 font-semibold"
        >
          {processing ? 'Processing...' : 'Pay Now'}
        </button>
        {message && <p className="text-sm">{message}</p>}
      </section>
    </main>
  )
}
