export type GuestOrderRow = Record<string, unknown> & {
  id: string
  restaurant_id?: string | null
  table_number?: number | null
  session_id?: string | null
  is_closed?: boolean | null
  status?: string | null
  payment_status?: string | null
  payment_channel?: string | null
  tab_id?: string | null
  tab_settlement_for_tab_id?: string | null
}

export type GuestOrdersApiResponse = {
  orders: GuestOrderRow[]
  count?: number
}
