/**
 * THE SWITCHER MUST APPEAR ONLY WHEN THERE IS A CHOICE, AND MUST NEVER OFFER ONE THE USER
 * DOES NOT HOLD.
 *
 * Context: on 2026-08-19 an organisation held three restaurants and the owner could not reach the
 * newest one. #321 fixed the resolution half (pick-session-restaurant.ts) and left the product with
 * no way to express a choice -- app/choose-context is unreachable once a valid context is stored.
 *
 * THE POSITIVE CONTROL IS THE SECURITY HALF: a single-restaurant account gets no switcher, and the
 * option list is built only from the contexts the server derived from restaurant_users, so a
 * restaurant the user holds no membership row on cannot appear. Both widening tests below would
 * still pass if that were broken, which is why the control is asserted separately.
 */
export {} // module scope

import { buildRestaurantSwitcher } from '@/lib/auth/restaurant-switcher-options'

const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const NEDBANK = '38c493cf-a665-42c5-9c3e-858fbdb52b40'
const FNB_CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'

const restaurant = (restaurantId: string, restaurantName: string) => ({
  type: 'restaurant',
  restaurantId,
  restaurantName,
})

describe('showing the switcher', () => {
  it('is visible for an account with more than one restaurant', () => {
    const model = buildRestaurantSwitcher({
      contexts: [restaurant(RIVIERA, 'Riviera'), restaurant(NEDBANK, 'Chownow Nedbank')],
      currentRestaurantId: RIVIERA,
    })

    expect(model.visible).toBe(true)
    expect(model.options.map((o) => o.restaurantName)).toEqual(['Riviera', 'Chownow Nedbank'])
  })

  it('marks the current restaurant, and only the current one', () => {
    const model = buildRestaurantSwitcher({
      contexts: [restaurant(RIVIERA, 'Riviera'), restaurant(NEDBANK, 'Chownow Nedbank')],
      currentRestaurantId: NEDBANK,
    })

    expect(model.options.filter((o) => o.isCurrent).map((o) => o.restaurantId)).toEqual([NEDBANK])
  })

  it('lists every restaurant the user belongs to, not just the non-current ones', () => {
    // The switcher is also the only place the current location is named as one of several --
    // dropping it would make "which one am I on" unanswerable from the control itself.
    const model = buildRestaurantSwitcher({
      contexts: [
        restaurant(RIVIERA, 'Riviera'),
        restaurant(NEDBANK, 'Chownow Nedbank'),
        restaurant(FNB_CHOWNOW, 'FNB ChowNow'),
      ],
      currentRestaurantId: RIVIERA,
    })

    expect(model.options).toHaveLength(3)
  })
})

describe('POSITIVE CONTROL -- a single-restaurant account gets no switcher', () => {
  it('is not visible with exactly one restaurant', () => {
    const model = buildRestaurantSwitcher({
      contexts: [restaurant(RIVIERA, 'Riviera')],
      currentRestaurantId: RIVIERA,
    })

    expect(model.visible).toBe(false)
  })

  it('is not visible with no restaurants at all', () => {
    expect(buildRestaurantSwitcher({ contexts: [], currentRestaurantId: null }).visible).toBe(false)
    expect(buildRestaurantSwitcher({ contexts: null, currentRestaurantId: null }).visible).toBe(false)
  })

  it('does not become visible because a platform context exists alongside one restaurant', () => {
    // A platform admin who owns one restaurant has two CONTEXTS and one RESTAURANT. Counting
    // contexts instead of restaurants would show a switcher whose only real option is the
    // restaurant they are already on.
    const model = buildRestaurantSwitcher({
      contexts: [{ type: 'platform' }, restaurant(RIVIERA, 'Riviera')],
      currentRestaurantId: RIVIERA,
    })

    expect(model.visible).toBe(false)
    expect(model.options).toHaveLength(1)
  })
})

describe('POSITIVE CONTROL -- the list cannot offer a non-membership', () => {
  it('offers nothing beyond the contexts it was given', () => {
    // The contexts come from resolveUserContexts(), which reads restaurant_users. FNB ChowNow is
    // a real restaurant in the same organisation that this account holds NO row on, so it must
    // not appear -- organisation membership is not restaurant membership.
    const model = buildRestaurantSwitcher({
      contexts: [restaurant(RIVIERA, 'Riviera'), restaurant(NEDBANK, 'Chownow Nedbank')],
      currentRestaurantId: RIVIERA,
    })

    expect(model.options.map((o) => o.restaurantId)).not.toContain(FNB_CHOWNOW)
  })

  it('drops entries with no restaurant id rather than rendering a selectable blank', () => {
    const model = buildRestaurantSwitcher({
      contexts: [
        restaurant(RIVIERA, 'Riviera'),
        restaurant(NEDBANK, 'Chownow Nedbank'),
        { type: 'restaurant', restaurantId: '', restaurantName: 'Broken' },
        { type: 'restaurant', restaurantId: null, restaurantName: 'Also broken' },
      ],
      currentRestaurantId: RIVIERA,
    })

    expect(model.options).toHaveLength(2)
  })

  it('does not count the same restaurant twice into visibility', () => {
    // A duplicate row would otherwise make a single-restaurant account look like a choice.
    const model = buildRestaurantSwitcher({
      contexts: [restaurant(RIVIERA, 'Riviera'), restaurant(RIVIERA, 'Riviera')],
      currentRestaurantId: RIVIERA,
    })

    expect(model.visible).toBe(false)
    expect(model.options).toHaveLength(1)
  })
})

describe('naming', () => {
  it('falls back to the id rather than rendering an empty label', () => {
    const model = buildRestaurantSwitcher({
      contexts: [restaurant(RIVIERA, '   '), restaurant(NEDBANK, 'Chownow Nedbank')],
      currentRestaurantId: NEDBANK,
    })

    expect(model.options[0].restaurantName).toBe(RIVIERA)
  })
})
