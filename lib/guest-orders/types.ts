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
  /**
   * The caller had rows that a table close has since put out of reach (#313).
   *
   * A COURTESY, not a gate: it exists so a screen can explain an empty list rather than leave it
   * looking like a lost order. The boundary that withheld the rows is enforced on the server in
   * lib/guest-orders/session-boundary.ts, and nothing a client does with this flag changes it.
   *
   * Optional because not every guest-orders endpoint computes it — read it as "not known to have
   * ended", never as "still current".
   */
  sessionEnded?: boolean
}
