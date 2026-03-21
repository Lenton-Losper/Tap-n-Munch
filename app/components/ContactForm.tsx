'use client'

import { FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ContactFormData = {
  name: string
  venueName: string
  email: string
  phone: string
}

const initialData: ContactFormData = {
  name: '',
  venueName: '',
  email: '',
  phone: '',
}

type ContactFormProps = {
  submitLabel?: string
}

export function ContactForm({ submitLabel = 'Request Demo' }: ContactFormProps) {
  const [formData, setFormData] = useState<ContactFormData>(initialData)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  const updateField = (field: keyof ContactFormData, value: string) => {
    setSubmitted(false)
    setError('')
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    if (!formData.name || !formData.venueName || !formData.email || !formData.phone) {
      setError('Please complete all required fields.')
      return
    }

    console.log('FlashTap contact form submission:', formData)
    setSubmitted(true)
    setFormData(initialData)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="name" className="text-[#37352F]">
          Name *
        </Label>
        <Input
          id="name"
          name="name"
          value={formData.name}
          onChange={(event) => updateField('name', event.target.value)}
          required
          className="rounded-lg border-0 border-b border-[#E9E9E7] bg-transparent px-0 text-[#37352F] shadow-none placeholder:text-[#9B978E] focus-visible:ring-0"
          placeholder="Jane Doe"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="venueName" className="text-[#37352F]">
          Venue Name *
        </Label>
        <Input
          id="venueName"
          name="venueName"
          value={formData.venueName}
          onChange={(event) => updateField('venueName', event.target.value)}
          required
          className="rounded-lg border-0 border-b border-[#E9E9E7] bg-transparent px-0 text-[#37352F] shadow-none placeholder:text-[#9B978E] focus-visible:ring-0"
          placeholder="Your Venue"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email" className="text-[#37352F]">
          Email *
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          value={formData.email}
          onChange={(event) => updateField('email', event.target.value)}
          required
          className="rounded-lg border-0 border-b border-[#E9E9E7] bg-transparent px-0 text-[#37352F] shadow-none placeholder:text-[#9B978E] focus-visible:ring-0"
          placeholder="you@venue.com"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone" className="text-[#37352F]">
          Phone *
        </Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          value={formData.phone}
          onChange={(event) => updateField('phone', event.target.value)}
          required
          className="rounded-lg border-0 border-b border-[#E9E9E7] bg-transparent px-0 text-[#37352F] shadow-none placeholder:text-[#9B978E] focus-visible:ring-0"
          placeholder="+1 555 123 4567"
        />
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {submitted ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Thanks! Your message has been received.
        </p>
      ) : null}

      <Button
        type="submit"
        className="w-full rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27] focus-visible:ring-[#37352F]"
      >
        {submitLabel}
      </Button>
    </form>
  )
}

