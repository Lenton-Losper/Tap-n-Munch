'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  FOOD_IMAGE_DEFAULT_FALLBACK,
  getFoodImage,
  getFoodImageKeywordFallback,
} from '@/lib/menu/get-food-image'

export type FoodItemImageProps = {
  itemName: string
  storedImageUrl?: string | null
  alt: string
  className?: string
  style?: React.CSSProperties
  loadingClassName?: string
}

export function FoodItemImage({
  itemName,
  storedImageUrl,
  alt,
  className,
  style,
  loadingClassName,
}: FoodItemImageProps) {
  const trimmed = storedImageUrl?.trim() || ''
  const [src, setSrc] = useState<string | undefined>(() => (trimmed ? trimmed : undefined))
  const [loading, setLoading] = useState(!trimmed)
  const errorStepRef = useRef(0)

  useEffect(() => {
    errorStepRef.current = 0
    const t = storedImageUrl?.trim() || ''
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
  }, [itemName, storedImageUrl])

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
