'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
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
  const storedSrc = resolveStoredSrc(storedImageUrl, menuItemId)
  const [fetchedSrc, setFetchedSrc] = useState<string | undefined>()
  const [fetching, setFetching] = useState(false)
  const [errorOverrideSrc, setErrorOverrideSrc] = useState<string | null>(null)
  const errorStepRef = useRef(0)

  /* eslint-disable react-hooks/set-state-in-effect -- reset image fallback when item identity changes */
  useEffect(() => {
    errorStepRef.current = 0
    setErrorOverrideSrc(null)
    if (storedSrc) return
    let cancelled = false
    setFetching(true)
    setFetchedSrc(undefined)
    ;(async () => {
      const url = await getFoodImage(itemName)
      if (!cancelled) {
        setFetchedSrc(url)
        setFetching(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [itemName, storedSrc])
  /* eslint-enable react-hooks/set-state-in-effect */

  const src = errorOverrideSrc ?? storedSrc ?? fetchedSrc
  const loading = !storedSrc && (fetching || !src)

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
    <div className={cn('relative', className)} style={style}>
      <Image
        src={src}
        alt={alt}
        fill
        className="object-cover"
        unoptimized
        onError={() => {
          if (errorStepRef.current === 0) {
            errorStepRef.current = 1
            setErrorOverrideSrc(getFoodImageKeywordFallback(itemName))
          } else {
            setErrorOverrideSrc(FOOD_IMAGE_DEFAULT_FALLBACK)
          }
        }}
      />
    </div>
  )
}
