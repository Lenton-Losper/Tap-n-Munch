'use client'

import { useState } from 'react'
import Image from 'next/image'

export default function FlashTapPayPage() {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [merchantName, setMerchantName] = useState('FlashTap Merchant')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')

  const generate = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await fetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Number(amount),
          note,
          merchantName,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Unable to generate payment')
      setResult(data)
    } catch (e: any) {
      setError(e.message || 'Failed to generate payment')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-xl p-6 space-y-4">
      <h1 className="text-2xl font-bold">FlashTap Pay</h1>
      <p className="text-sm text-muted-foreground">
        Enter amount and note, then generate a PayCloud QR and payment link.
      </p>

      <input
        className="w-full border p-2"
        placeholder="Merchant name"
        value={merchantName}
        onChange={(e) => setMerchantName(e.target.value)}
      />
      <input
        className="w-full border p-2"
        placeholder="Amount (NAD)"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        className="w-full border p-2"
        placeholder="Optional note (e.g. taxi fare)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className={`border px-4 py-2 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
        disabled={loading}
        onClick={generate}
      >
        {loading ? 'Generating...' : 'Generate'}
      </button>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      {result && (
        <div className="space-y-3 border p-4">
          <p className="text-sm">
            <strong>Branded page:</strong>{' '}
            <a className="underline" href={result.shareUrl} target="_blank" rel="noreferrer">
              Open customer page
            </a>
          </p>
          <p className="text-sm">
            <strong>Payment link:</strong>{' '}
            <a className="underline" href={result.checkoutUrl} target="_blank" rel="noreferrer">
              Open checkout
            </a>
          </p>
          <p className="text-sm">
            <strong>WhatsApp share:</strong>{' '}
            <a
              className="underline"
              href={`https://wa.me/?text=${encodeURIComponent(`Pay here: ${result.shareUrl}`)}`}
              target="_blank"
              rel="noreferrer"
            >
              Send link
            </a>
          </p>
          {result.qrBase64 && (
            <Image
              src={result.qrBase64}
              alt="Payment QR code"
              width={224}
              height={224}
              className="border"
              unoptimized
            />
          )}
          {result.qrSvg && <textarea className="w-full border p-2 text-xs" rows={8} readOnly value={result.qrSvg} />}
          {result.expiresAt && <p className="text-xs text-muted-foreground">Expires at: {result.expiresAt}</p>}
        </div>
      )}
    </div>
  )
}
