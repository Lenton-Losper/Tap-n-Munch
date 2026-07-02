'use client'

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import Image from 'next/image'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'
import { getAccessToken, onboardingFetch } from '@/lib/onboarding/api-client'
import type { StepHandle } from './types'

type StepProfileProps = {
  restaurantId: string
  initialName: string
  initialPhone: string
  initialAddress: string
  initialCurrency: string
  initialLogoUrl: string | null
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
}

export const StepProfile = forwardRef<StepHandle, StepProfileProps>(function StepProfile(
  {
    restaurantId,
    initialName,
    initialPhone,
    initialAddress,
    initialCurrency,
    initialLogoUrl,
    onError,
    setSaving,
  },
  ref
) {
  const [name, setName] = useState(initialName)
  const [phone, setPhone] = useState(initialPhone)
  const [address, setAddress] = useState(initialAddress)
  const [currency, setCurrency] = useState(initialCurrency || 'NAD')
  const [logoPreview, setLogoPreview] = useState<string | null>(
    initialLogoUrl ? restaurantLogoDisplayUrl(restaurantId, initialLogoUrl) : null
  )
  const [logoStoragePath, setLogoStoragePath] = useState<string | null>(initialLogoUrl)
  const [logoFile, setLogoFile] = useState<File | null>(null)

  useEffect(() => {
    setName(initialName)
    setPhone(initialPhone)
    setAddress(initialAddress)
    setCurrency(initialCurrency || 'NAD')
    setLogoStoragePath(initialLogoUrl)
    setLogoPreview(
      initialLogoUrl ? restaurantLogoDisplayUrl(restaurantId, initialLogoUrl) : null
    )
  }, [initialName, initialPhone, initialAddress, initialCurrency, initialLogoUrl, restaurantId])

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!name.trim()) {
        onError('Restaurant name is required')
        return false
      }

      setSaving(true)
      onError('')

      try {
        let logoUrl = logoStoragePath

        if (logoFile) {
          const token = await getAccessToken()
          const formData = new FormData()
          formData.append('file', logoFile)
          formData.append('restaurantId', restaurantId)

          const uploadResponse = await fetch('/api/admin/upload-logo', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          })
          const uploadPayload = await uploadResponse.json()
          if (!uploadResponse.ok) {
            throw new Error(uploadPayload?.error || 'Failed to upload logo')
          }
          logoUrl = uploadPayload.storagePath || logoUrl
        }

        await onboardingFetch('/api/admin/restaurant/profile', {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            phone: phone.trim(),
            address: address.trim(),
            currency,
            logoUrl: logoUrl || undefined,
          }),
        })

        return true
      } catch (error: unknown) {
        onError(error instanceof Error ? error.message : 'Failed to save profile')
        return false
      } finally {
        setSaving(false)
      }
    },
  }))

  const handleLogoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="restaurantName">Restaurant Name</Label>
        <Input
          id="restaurantName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="The Riverside Bistro"
          className="rounded-lg border-[#E9E9E7]"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input
          id="phone"
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+264 81 123 4567"
          className="rounded-lg border-[#E9E9E7]"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">Address</Label>
        <Input
          id="address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="123 Main Street, Windhoek"
          className="rounded-lg border-[#E9E9E7]"
        />
      </div>

      <div className="space-y-2">
        <Label>Currency</Label>
        <Select value={currency} onValueChange={setCurrency}>
          <SelectTrigger className="rounded-lg border-[#E9E9E7]">
            <SelectValue placeholder="Select currency" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="NAD">NAD — Namibian Dollar</SelectItem>
            <SelectItem value="ZAR">ZAR — South African Rand</SelectItem>
            <SelectItem value="USD">USD — US Dollar</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="logo">Logo</Label>
        <Input
          id="logo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleLogoChange}
          className="rounded-lg border-[#E9E9E7]"
        />
        {logoPreview ? (
          <Image
            src={logoPreview}
            alt="Restaurant logo preview"
            width={80}
            height={80}
            className="mt-2 h-20 w-20 rounded-lg border border-[#E9E9E7] object-cover"
            unoptimized
          />
        ) : null}
      </div>
    </div>
  )
})
