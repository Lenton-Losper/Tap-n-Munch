/**
 * OrderChannel — the ordering channel for a customer session.
 * Centralizes channel detection instead of scattering isKiosk booleans.
 */

export enum OrderChannel {
  TABLE = 'table',
  KIOSK = 'kiosk',
  ONLINE = 'online',
}

export interface OrderingContext {
  channel: OrderChannel
  customerName: string
  tableNumber: number
  tableParam: string
}

export function getOrderingContext(searchParams: URLSearchParams | null): OrderingContext {
  const tableParam = searchParams?.get('table') ?? ''
  const tableNumber = parseInt(tableParam) || 0
  const isKiosk = searchParams?.get('kiosk') === 'true'
  const customerName = searchParams?.get('name')?.trim() ?? ''

  return {
    channel: isKiosk ? OrderChannel.KIOSK : OrderChannel.TABLE,
    customerName,
    tableNumber,
    tableParam,
  }
}

export function isKioskChannel(ctx: OrderingContext): boolean {
  return ctx.channel === OrderChannel.KIOSK
}
