'use client'

import { Button } from '@/components/ui/button'
import { Banknote, CreditCard, Check } from 'lucide-react'
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
  const methods: Array<{ value: PaymentMethod; label: string; icon: typeof Banknote; emoji: string; description: string }> = [
    {
      value: 'cash',
      label: 'Cash',
      icon: Banknote,
      emoji: '💵',
      description: 'Pay with cash at your table',
    },
    {
      value: 'card',
      label: 'Card',
      icon: CreditCard,
      emoji: '💳',
      description: 'Waiter will bring card machine',
    },
  ]

  // Defensive guard: default to all methods if enabledMethods is undefined or not an array
  const safeEnabledMethods = Array.isArray(enabledMethods) && enabledMethods.length > 0 
    ? enabledMethods 
    : ['cash', 'card'] as PaymentMethod[]

  const availableMethods = methods.filter((m) => safeEnabledMethods.includes(m.value))

  if (availableMethods.length === 0) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-center">
        <p className="text-sm text-yellow-900 font-medium">
          No payment methods available. Please contact the restaurant.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {availableMethods.map((method) => {
        const Icon = method.icon
        const isSelected = selectedMethod === method.value

        return (
          <button
            key={method.value}
            type="button"
            onClick={() => !disabled && onSelect(method.value)}
            disabled={disabled}
            className={cn(
              'w-full min-h-[60px] p-4 rounded-lg border-2 transition-all text-left',
              'flex items-center justify-between gap-4',
              'hover:border-[#FF6B35] hover:bg-orange-50/50',
              disabled && 'opacity-50 cursor-not-allowed',
              isSelected
                ? 'border-[#FF6B35] bg-orange-50/50 shadow-sm'
                : 'border-gray-200 bg-white'
            )}
          >
            <div className="flex items-center gap-4 flex-1">
              <div
                className={cn(
                  'w-12 h-12 rounded-lg flex items-center justify-center text-2xl',
                  isSelected ? 'bg-[#FF6B35]' : 'bg-gray-100'
                )}
              >
                {method.emoji}
              </div>
              <div className="flex-1">
                <div className="font-semibold text-base">{method.label}</div>
                <div className="text-sm text-gray-600">{method.description}</div>
              </div>
            </div>
            {isSelected && (
              <div className="w-6 h-6 rounded-full bg-[#FF6B35] flex items-center justify-center flex-shrink-0">
                <Check className="h-4 w-4 text-white" />
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}

