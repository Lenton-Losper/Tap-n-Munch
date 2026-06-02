'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  FOOD_IMAGE_DEFAULT_FALLBACK,
  getFoodImage,
  getFoodImageKeywordFallback,
} from '@/lib/menu/get-food-image'
import { menuItemImageDisplayUrl } from '@/lib/menu-item-image'

export type FoodItemImageProps = {
  itemName: string
  storedImageUrl?: string | null
  /** When set, Supabase storage paths / legacy public URLs are served via /api/media/menu-item/ */
  menuItemId?: string
  alt: string
  className?: string
  style?: React.CSSProperties
  loadingClassName?: string
}

function resolveStoredSrc(storedImageUrl: string | null | undefined, menuItemId?: string): string {
  const trimmed = storedImageUrl?.trim() || ''
  if (!trimmed) return ''
  if (menuItemId) {
    return menuItemImageDisplayUrl(menuItemId, trimmed) || trimmed
  }
  return trimmed
}

export function FoodItemImage({
  itemName,
  storedImageUrl,
  menuItemId,
  alt,
  className,
  style,
  loadingClassName,
}: FoodItemImageProps) {
  const trimmed = resolveStoredSrc(storedImageUrl, menuItemId)
  const [src, setSrc] = useState<string | undefined>(() => (trimmed ? trimmed : undefined))
  const [loading, setLoading] = useState(!trimmed)
  const errorStepRef = useRef(0)

  useEffect(() => {
    errorStepRef.current = 0
    const t = resolveStoredSrc(storedImageUrl, menuItemId)
    if (t) {
      setSrc(t)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setSrc(undefined)
    ;(async () => {
      const url = await getFoodImage(itemName)
      if (!cancelled) {
        setSrc(url)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [itemName, storedImageUrl, menuItemId])

  if (loading || !src) {
    return (
      <div
        className={cn('bg-muted animate-pulse', loadingClassName, className)}
        style={style}
        aria-hidden
      />
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      onError={() => {
        if (errorStepRef.current === 0) {
          errorStepRef.current = 1
          setSrc(getFoodImageKeywordFallback(itemName))
        } else {
          setSrc(FOOD_IMAGE_DEFAULT_FALLBACK)
        }
      }}
    />
  )
}
