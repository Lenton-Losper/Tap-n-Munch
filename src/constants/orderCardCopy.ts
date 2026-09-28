/**
 * THE ORDER LIST CARD'S MONEY LINE.
 *
 * Sprint 2026-09-29 brief (F-TERMPAY, task 8). DRAFTED, NOT YET SIGNED — house style as signed
 * 2026-08-28.
 *
 * The card used to show `orders.total`, the stored original, which a void never rewrites. It now
 * shows the server's LIVE figure (GET /api/terminal/orders `financials`), with the original beside
 * it when they differ (LIVE_TOTAL_AFTER_VOIDS) and what is still owed when part has been paid. When
 * the server sent no figures, the stored total is shown as what was ORDERED, never as what is owed.
 */
/** `{owed}` is the outstanding amount, shown only when it differs from the live value. */
export const ORDER_CARD_STILL_OWED = '{owed} still owed';
/** `{total}` is the stored total, shown only when the live figures could not be read. */
export const ORDER_CARD_ORDERED = 'Ordered {total}';
