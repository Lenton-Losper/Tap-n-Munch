'use client'

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type PaymentMethod = 'cash' | 'card'

interface PaymentMethodSelectorProps {
  value: PaymentMethod | null
  onChange: (method: PaymentMethod) => void
  enabledMethods?: PaymentMethod[]
  disabled?: boolean
}

export function PaymentMethodSelector({
  value: selectedMethod,
  onChange: onSelect,
  enabledMethods,
  disabled = false,
}: PaymentMethodSelectorProps) {
  const methods: Array<{ value: PaymentMethod; label: string; emoji: string; description: string }> = [
    {
      value: 'cash',
      label: 'Cash',
      emoji: '💵',
      description: 'Pay with cash at your table',
    },
    {
      value: 'card',
      label: 'Card',
      emoji: '💳',
      description: 'Waiter will bring card machine',
    },
  ]

  const safeEnabledMethods = Array.isArray(enabledMethods) && enabledMethods.length > 0 
    ? enabledMethods 
    : ['cash', 'card'] as PaymentMethod[]

  const availableMethods = methods.filter((m) => safeEnabledMethods.includes(m.value))

  if (availableMethods.length === 0) {
    return (
      <div className="bg-muted border border-border p-4 text-center">
        <p className="text-sm text-muted-foreground font-sans">
          No payment methods available. Please contact the restaurant.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {availableMethods.map((method) => {
        const isSelected = selectedMethod === method.value

        return (
          <button
            key={method.value}
            type="button"
            onClick={() => !disabled && onSelect(method.value)}
            disabled={disabled}
            className={cn(
              'w-full min-h-[60px] p-4 border transition-all text-left font-sans',
              'flex items-center justify-between gap-4',
              'hover:border-foreground',
              disabled && 'opacity-50 cursor-not-allowed',
              isSelected
                ? 'border-foreground bg-muted'
                : 'border-border bg-card'
            )}
          >
            <div className="flex items-center gap-4 flex-1">
              <div
                className={cn(
                  'w-12 h-12 flex items-center justify-center text-2xl',
                  isSelected ? 'bg-foreground text-background' : 'bg-muted'
                )}
              >
                {method.emoji}
              </div>
              <div className="flex-1">
                <div className="font-semibold text-base text-foreground">{method.label}</div>
                <div className="text-sm text-muted-foreground">{method.description}</div>
              </div>
            </div>
            {isSelected && (
              <div className="w-6 h-6 bg-foreground flex items-center justify-center flex-shrink-0">
                <Check className="h-4 w-4 text-background stroke-[2]" />
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}
