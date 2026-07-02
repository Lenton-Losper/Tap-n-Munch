import {
  nextKioskTableNumber,
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
})
