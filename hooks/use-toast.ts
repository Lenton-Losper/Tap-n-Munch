'use client'

// Inspired by react-hot-toast library
import * as React from 'react'

import type { ToastActionElement, ToastProps } from '@/components/ui/toast'

/**
 * #208 — HOW MANY TOASTS ARE VISIBLE AT ONCE, app-wide.
 *
 * The ruling was that this number is decided BY the replacement, not fixed first in the stack being
 * retired. The replacement is browse's add-to-cart confirmation, which is the most-repeated
 * interaction in the product: a customer adds three items in a few seconds and got three
 * confirmations, because the hand-rolled stack it replaces had NO limit at all.
 *
 * At 1 that becomes one confirmation, replaced twice — a behaviour regression on the busiest
 * customer screen, and the reason this issue insisted the number be settled before the swap.
 *
 * 3 is the smallest number that keeps the old behaviour intelligible while BOUNDING what was
 * previously unbounded. It is bounded because of the viewport, not out of taste: below `sm` the
 * shared viewport is `fixed top-0 w-full` (components/ui/toast.tsx), so each toast is a
 * full-width band across the top of a phone. An unbounded stack there covers the screen.
 *
 * IT IS APP-WIDE, INCLUDING app/(staff)/**. One module-level store feeds every `<Toaster />`, so
 * there is no per-route limit to set. Staff toasts fire one per action, so the change is only
 * reachable there when two actions land together — where showing both is the better answer anyway.
 */
const TOAST_LIMIT = 3
const TOAST_REMOVE_DELAY = 1000000

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}

const actionTypes = {
  ADD_TOAST: 'ADD_TOAST',
  UPDATE_TOAST: 'UPDATE_TOAST',
  DISMISS_TOAST: 'DISMISS_TOAST',
  REMOVE_TOAST: 'REMOVE_TOAST',
} as const

let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

type ActionType = typeof actionTypes

type Action =
  | {
      type: ActionType['ADD_TOAST']
      toast: ToasterToast
    }
  | {
      type: ActionType['UPDATE_TOAST']
      toast: Partial<ToasterToast>
    }
  | {
      type: ActionType['DISMISS_TOAST']
      toastId?: ToasterToast['id']
    }
  | {
      type: ActionType['REMOVE_TOAST']
      toastId?: ToasterToast['id']
    }

interface State {
  toasts: ToasterToast[]
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId)
    dispatch({
      type: 'REMOVE_TOAST',
      toastId: toastId,
    })
  }, TOAST_REMOVE_DELAY)

  toastTimeouts.set(toastId, timeout)
}

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD_TOAST':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      }

    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t,
        ),
      }

    case 'DISMISS_TOAST': {
      const { toastId } = action

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId)
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id)
        })
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t,
        ),
      }
    }
    case 'REMOVE_TOAST':
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        }
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      }
  }
}

const listeners: Array<() => void> = []

let memoryState: State = { toasts: [] }

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach((listener) => {
    listener()
  })
}

/**
 * Store plumbing for useSyncExternalStore (#207).
 *
 * `getSnapshot` may only return a value that is REFERENTIALLY STABLE between dispatches, or React
 * re-renders forever. It is: every branch of `reducer` above builds a new object, and `memoryState`
 * is reassigned only inside `dispatch`.
 *
 * `getServerSnapshot` is the same function on purpose. This module is 'use client', but Next still
 * renders client components on the server, where the store is always the initial empty state.
 */
function subscribe(onStoreChange: () => void) {
  listeners.push(onStoreChange)
  return () => {
    const index = listeners.indexOf(onStoreChange)
    if (index > -1) {
      listeners.splice(index, 1)
    }
  }
}

function getSnapshot(): State {
  return memoryState
}

type Toast = Omit<ToasterToast, 'id'>

function toast({ ...props }: Toast) {
  const id = genId()

  const update = (props: ToasterToast) =>
    dispatch({
      type: 'UPDATE_TOAST',
      toast: { ...props, id },
    })
  const dismiss = () => dispatch({ type: 'DISMISS_TOAST', toastId: id })

  dispatch({
    type: 'ADD_TOAST',
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss()
      },
    },
  })

  return {
    id: id,
    dismiss,
    update,
  }
}

/*
 * A TOAST FIRED FROM A MOUNT EFFECT USED TO BE DROPPED (#207).
 *
 * This was `useState(memoryState)` seeded at render plus `useEffect(() => listeners.push(setState))`
 * to subscribe. Those are two different moments, and React runs effects in child order, so a toast
 * dispatched from an earlier child's mount effect was written to the store while nothing that could
 * paint it was subscribed yet -- and the viewport's captured initial state was never re-read. No
 * error, no message, nothing to notice.
 *
 * useSyncExternalStore exists for exactly this hazard: it subscribes before paint and re-reads the
 * snapshot after subscribing, so a dispatch in that window cannot be missed. It removes the class
 * rather than this instance, which is why it is preferred over seeding in a layout effect.
 */
function useToast() {
  const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: 'DISMISS_TOAST', toastId }),
  }
}

export { useToast, toast }
