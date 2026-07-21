import {
  nextKioskTableNumber,
  nextViewOnlyTableNumber,
  orderingPointDisplayName,
  resolveOrderingPointQrUrl,
} from '../lib/tables/ordering-points'

describe('ordering-points helpers', () => {
  test('nextKioskTableNumber starts at 1001 when none exist', () => {
    expect(nextKioskTableNumber([])).toBe(1001)
    expect(nextKioskTableNumber([1, 2, 3])).toBe(1001)
  })

  test('nextKioskTableNumber increments from highest kiosk number', () => {
    expect(nextKioskTableNumber([1001, 1003, 5])).toBe(1004)
  })

  test('nextKioskTableNumber skips collisions when incrementing', () => {
    expect(nextKioskTableNumber([1001, 1002, 1003])).toBe(1004)
    expect(nextKioskTableNumber([1001, 1002, 1004])).toBe(1005)
  })

  test('resolveOrderingPointQrUrl uses kiosk route for kiosk rows', () => {
    const url = resolveOrderingPointQrUrl('rest-1', {
      is_kiosk: true,
      table_number: 1001,
      qr_code_url: null,
    })
    expect(url).toContain('/kiosk?table=1001')
  })

  test('resolveOrderingPointQrUrl uses v2 for dining tables', () => {
    const url = resolveOrderingPointQrUrl('rest-1', {
      is_kiosk: false,
      table_number: 3,
      qr_code_url: 'https://example.com/menu/rest-1/v2?table=3',
    })
    expect(url).toContain('/v2?table=3')
  })

  test('orderingPointDisplayName hides internal table number for kiosks', () => {
    expect(
      orderingPointDisplayName({
        id: '1',
        table_number: 1001,
        table_name: 'Counter',
        is_kiosk: true,
      }),
    ).toBe('Counter')
  })

  test('orderingPointDisplayName shows table number for dining tables', () => {
    expect(
      orderingPointDisplayName({
        id: '1',
        table_number: 7,
        table_name: 'Table 7',
        is_kiosk: false,
      }),
    ).toBe('Table 7')
  })

  test('nextViewOnlyTableNumber starts at 5001 when none exist', () => {
    expect(nextViewOnlyTableNumber([])).toBe(5001)
    expect(nextViewOnlyTableNumber([1, 2, 1001, 1002])).toBe(5001)
  })

  test('nextViewOnlyTableNumber increments from highest view-only number and skips collisions', () => {
    expect(nextViewOnlyTableNumber([5001, 5002, 5])).toBe(5003)
    expect(nextViewOnlyTableNumber([5001, 5002, 5003])).toBe(5004)
  })

  test('nextKioskTableNumber never collides with the view-only range', () => {
    // Even if a restaurant somehow has 5000+ kiosks, kiosk numbering must stay under
    // VIEW_ONLY_TABLE_NUMBER_START rather than wandering into it.
    expect(nextKioskTableNumber([1001, 5001, 5002])).toBe(1002)
  })

  test('resolveOrderingPointQrUrl uses the plain v2 link for view-only points (same shape as a table)', () => {
    const url = resolveOrderingPointQrUrl('rest-1', {
      is_kiosk: false,
      table_number: 5001,
      qr_code_url: 'https://example.com/menu/rest-1/v2?table=5001',
    })
    expect(url).toContain('/v2?table=5001')
    expect(url).not.toContain('/kiosk')
  })

  test('orderingPointDisplayName shows a friendly name for view-only points, not the raw table number', () => {
    expect(
      orderingPointDisplayName({
        id: '1',
        table_number: 5001,
        table_name: 'Entrance',
        is_kiosk: false,
        is_view_only: true,
      }),
    ).toBe('Entrance')
    expect(
      orderingPointDisplayName({
        id: '2',
        table_number: 5002,
        table_name: null,
        is_kiosk: false,
        is_view_only: true,
      }),
    ).toBe('Menu QR')
  })
})
