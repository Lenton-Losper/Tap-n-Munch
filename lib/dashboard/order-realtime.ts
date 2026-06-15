export type OrderRealtimePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

type OrderRow = Record<string, any> & { id: string; is_closed?: boolean }

/** Apply a Supabase Realtime postgres_changes payload to the local open-orders list. */
export function applyOrderRealtimeEvent<T extends OrderRow>(
  prev: T[],
  payload: OrderRealtimePayload
): T[] {
  const { eventType, new: newRow, old: oldRow } = payload
  const id = String((newRow?.id ?? oldRow?.id) || '').trim()
  if (!id) return prev

  if (eventType === 'DELETE') {
    return prev.filter((order) => order.id !== id)
  }

  const row = newRow as T | null
  if (!row) return prev

  if (row.is_closed === true) {
    return prev.filter((order) => order.id !== id)
  }

  const existingIndex = prev.findIndex((order) => order.id === id)
  if (existingIndex === -1) {
    return [row, ...prev]
  }

  return prev.map((order) => (order.id === id ? { ...order, ...row } : order))
}

export function countPendingHostedOrders(orders: OrderRow[]): number {
  return orders.filter(
    (order) =>
      String(order.payment_channel || '').toLowerCase() === 'hosted' &&
      String(order.payment_status || '').toLowerCase() === 'pending' &&
      order.is_closed !== true
  ).length
}

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioContext) {
    const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    audioContext = new Ctx()
  }
  return audioContext
}

/** Short two-tone chime for a new incoming order (requires prior user interaction on page). */
export function playNewOrderSound() {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }

    const playTone = (frequency: number, start: number, duration: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + duration + 0.02)
    }

    const now = ctx.currentTime
    playTone(880, now, 0.12)
    playTone(1174, now + 0.14, 0.16)
  } catch {
    // Audio is best-effort; ignore autoplay / unsupported browser errors.
  }
}

export function unlockNewOrderSound() {
  const ctx = getAudioContext()
  if (ctx?.state === 'suspended') {
    void ctx.resume()
  }
}
