/**
 * Phase 3.3 — one failing category must not empty the whole menu.
 *
 * app/menu/[restaurantId]/browse/page.tsx loaded every category through a single Promise.all
 * and, on any rejection, ran setAllGroupedItems({}). Promise.all rejects on the FIRST failure,
 * so one 500 on one category blanked the entire "All menu" view and the search index with it.
 *
 * On the QR entry surface that is indistinguishable from a restaurant that sells nothing — the
 * page's empty state says "Menu coming soon! / This restaurant hasn't added menu items yet."
 *
 * These tests run against a fake fetch, so they are hermetic: no network, no Supabase, no Redis.
 */
import {
  loadAllMenuCategories,
  fetchCategoryMenu,
  categoryMenuUrl,
} from '@/lib/menu/load-menu-categories'

const RESTAURANT = 'riviera'

const CATEGORIES = [
  { id: 'cat-food', name: 'Food' },
  { id: 'cat-drinks', name: 'Drinks' },
  { id: 'cat-desserts', name: 'Desserts' },
]

/** Payloads keyed by category id, shaped like the real API's grouped response. */
const PAYLOADS: Record<string, unknown> = {
  'cat-food': {
    'sub-burgers': {
      subcategory: { id: 'sub-burgers', name: 'Burgers', display_order: 1 },
      items: [{ id: 'item-burger', name: 'Beef Burger', base_price: 95 }],
    },
  },
  'cat-drinks': {
    'sub-soft': {
      subcategory: { id: 'sub-soft', name: 'Soft Drinks', display_order: 1 },
      items: [{ id: 'item-coke', name: 'Coke', base_price: 20 }],
    },
  },
  'cat-desserts': {
    'sub-cake': {
      subcategory: { id: 'sub-cake', name: 'Cake', display_order: 1 },
      items: [{ id: 'item-cheesecake', name: 'Cheesecake', base_price: 55 }],
    },
  },
}

/**
 * Fake fetch that serves PAYLOADS and fails for the category ids in `failing`.
 * `mode` picks the failure shape: a 500 from the API, or the fetch itself rejecting
 * (offline / DNS), because the page must survive both.
 */
function makeFetch(failing: string[] = [], mode: 'status' | 'reject' = 'status') {
  const calls: string[] = []

  const impl = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    const categoryId = decodeURIComponent(url.split('/').pop() || '')

    if (failing.includes(categoryId)) {
      if (mode === 'reject') throw new TypeError('Failed to fetch')
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Failed to load menu' }),
      }
    }

    return {
      ok: true,
      status: 200,
      json: async () => PAYLOADS[categoryId] ?? {},
    }
  }) as unknown as typeof fetch

  return { impl, calls }
}

function itemNames(load: Awaited<ReturnType<typeof loadAllMenuCategories>>) {
  return Object.values(load.merged)
    .flatMap((group) => group.items)
    .map((item) => String(item.name))
    .sort()
}

describe('loadAllMenuCategories — a failing category does not empty the menu', () => {
  it('returns every category when they all load', async () => {
    const { impl } = makeFetch()
    const load = await loadAllMenuCategories(RESTAURANT, CATEGORIES, impl)

    expect(itemNames(load)).toEqual(['Beef Burger', 'Cheesecake', 'Coke'])
    expect(load.failedCategoryNames).toEqual([])
    expect(load.requestedCount).toBe(3)
  })

  it('keeps the categories that loaded when one returns 500', async () => {
    const { impl } = makeFetch(['cat-drinks'])
    const load = await loadAllMenuCategories(RESTAURANT, CATEGORIES, impl)

    expect(itemNames(load)).toEqual(['Beef Burger', 'Cheesecake'])
    expect(load.failedCategoryNames).toEqual(['Drinks'])
  })

  it('keeps the categories that loaded when one fetch rejects outright', async () => {
    const { impl } = makeFetch(['cat-drinks'], 'reject')
    const load = await loadAllMenuCategories(RESTAURANT, CATEGORIES, impl)

    expect(itemNames(load)).toEqual(['Beef Burger', 'Cheesecake'])
    expect(load.failedCategoryNames).toEqual(['Drinks'])
  })

  it('names a failing FIRST category without dropping the ones after it', async () => {
    const { impl } = makeFetch(['cat-food'])
    const load = await loadAllMenuCategories(RESTAURANT, CATEGORIES, impl)

    expect(itemNames(load)).toEqual(['Cheesecake', 'Coke'])
    expect(load.failedCategoryNames).toEqual(['Food'])
  })

  it('reports a total failure distinguishably from a partial one', async () => {
    const { impl } = makeFetch(['cat-food', 'cat-drinks', 'cat-desserts'])
    const load = await loadAllMenuCategories(RESTAURANT, CATEGORIES, impl)

    expect(load.merged).toEqual({})
    expect(load.failedCategoryNames).toEqual(['Food', 'Drinks', 'Desserts'])
    // This equality is how the caller tells "nothing loaded" from "some loaded".
    expect(load.failedCategoryNames.length).toBe(load.requestedCount)
  })

  it('still requests every category rather than stopping at the first failure', async () => {
    const { impl, calls } = makeFetch(['cat-food'])
    await loadAllMenuCategories(RESTAURANT, CATEGORIES, impl)

    expect(calls).toHaveLength(3)
    expect(calls).toContain(categoryMenuUrl(RESTAURANT, 'cat-desserts'))
  })

  it('preserves each surviving category’s original order when an earlier one fails', async () => {
    const { impl } = makeFetch(['cat-food'])
    const load = await loadAllMenuCategories(RESTAURANT, CATEGORIES, impl)

    // Drinks is index 1 and Desserts index 2 in menuCategories. If the failed category were
    // compacted out before indexing, these would slide to 0 and 1 and the "All menu" sort
    // would silently reorder the menu.
    expect(load.merged['sub-soft'].subcategory.categoryOrder).toBe(1)
    expect(load.merged['sub-cake'].subcategory.categoryOrder).toBe(2)
    expect(load.merged['sub-soft'].subcategory.categoryName).toBe('Drinks')
  })

  it('merges items when two categories share a subcategory key', async () => {
    const shared = {
      'sub-shared': {
        subcategory: { id: 'sub-shared', name: 'Specials', display_order: 1 },
        items: [{ id: 'a', name: 'Special A' }],
      },
    }
    const sharedToo = {
      'sub-shared': {
        subcategory: { id: 'sub-shared', name: 'Specials', display_order: 1 },
        items: [{ id: 'b', name: 'Special B' }],
      },
    }
    const impl = (async (input: any) => ({
      ok: true,
      status: 200,
      json: async () => (String(input).includes('cat-one') ? shared : sharedToo),
    })) as unknown as typeof fetch

    const load = await loadAllMenuCategories(
      RESTAURANT,
      [
        { id: 'cat-one', name: 'One' },
        { id: 'cat-two', name: 'Two' },
      ],
      impl
    )

    expect(itemNames(load)).toEqual(['Special A', 'Special B'])
    // First contributor owns the heading.
    expect(load.merged['sub-shared'].subcategory.categoryName).toBe('One')
  })

  it('treats an empty category as empty, not as a failure', async () => {
    const impl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch

    const load = await loadAllMenuCategories(RESTAURANT, [{ id: 'cat-x', name: 'X' }], impl)

    expect(load.merged).toEqual({})
    expect(load.failedCategoryNames).toEqual([])
  })
})

describe('fetchCategoryMenu', () => {
  it('throws on a non-2xx so a fault is never mistaken for an empty category', async () => {
    const { impl } = makeFetch(['cat-food'])
    await expect(fetchCategoryMenu(RESTAURANT, 'cat-food', impl)).rejects.toThrow(
      'Menu API returned 500'
    )
  })

  it('returns the grouped payload on success', async () => {
    const { impl } = makeFetch()
    const grouped = await fetchCategoryMenu(RESTAURANT, 'cat-food', impl)
    expect(Object.keys(grouped)).toEqual(['sub-burgers'])
  })
})
