import {
  findRecipeQuantityWarnings,
  type RecipeQuantityLine,
} from '@/lib/recipes/quantity-sanity'

/**
 * Every fixture below is a row read off production on 2026-08-26, and every expectation is
 * written out as a literal. Nothing here recomputes the rule under test — if the detector's
 * arithmetic changes, these expectations do not move with it.
 */

/** Reduces a result to something a human can read in a failure diff. */
function codesByItem(warnings: ReturnType<typeof findRecipeQuantityWarnings>) {
  return warnings.map((w) => `${w.stockItemId}:${w.code}`)
}

function line(
  stockItemId: string,
  quantity: number | string,
  stockItemName: string,
  currentStock: number | null,
): RecipeQuantityLine {
  return { stockItemId, quantity, stockItemName, currentStock }
}

describe('findRecipeQuantityWarnings — the nine miskeyed Mingle recipes', () => {
  // menu item name, stock item name, recipe quantity, quantity RECEIVED into stock, balance on
  // 2026-08-26. All nine are single-ingredient one-to-one recipes, and on all nine the recipe
  // quantity is exactly the quantity received — which is the mistake being detected.
  const MINGLE: Array<[string, string, number, number, number]> = [
    ['Wedge biscuits', 'Wedge biscuits', 30, 30, 12],
    ['Powerade', 'Powerade', 24, 24, 100],
    ['Sausage roll', 'Sausage roll', 20, 20, 20],
    ['Popcorn', 'popcorn', 20, 20, 20],
    ['Mckane dry lemon', 'Mckane dry lemon', 12, 12, 12],
    ['Mckane lemonade', 'Mckane Lemonade', 12, 12, 12],
    ['Mckane soda water', 'Mckane soda water', 12, 12, 12],
    ['Mckane tonic water', 'Mckane tonic water', 12, 12, 12],
    ['Single brownie', 'Single brownie', 10, 10, 10],
  ]

  it('catches all nine at the moment they were typed', () => {
    // The warning that matters is the one shown while the recipe is being entered. Each of these
    // was entered just after its delivery was received, so the balance in front of the merchant
    // was the delivery quantity — the same number being typed into the quantity field.
    const actual = MINGLE.map(([menuName, stockName, qty, received]) => {
      const warnings = findRecipeQuantityWarnings(menuName, [line('s1', qty, stockName, received)])
      return `${menuName}=${warnings[0]?.code ?? 'NONE'}`
    })

    expect(actual).toEqual([
      'Wedge biscuits=equals_on_hand',
      'Powerade=equals_on_hand',
      'Sausage roll=equals_on_hand',
      'Popcorn=equals_on_hand',
      'Mckane dry lemon=equals_on_hand',
      'Mckane lemonade=equals_on_hand',
      'Mckane soda water=equals_on_hand',
      'Mckane tonic water=equals_on_hand',
      'Single brownie=equals_on_hand',
    ])
  })

  it('still catches eight of the nine against the balances standing today', () => {
    // Honest about the one it misses. Powerade was recounted UP to 100 after its miskey, so its
    // 24 no longer matches or exceeds anything and nothing about the numbers gives it away.
    // Re-opening that recipe today shows no warning; the detector prevents the mistake being
    // made, it does not find every instance already in the data.
    const actual = MINGLE.map(([menuName, stockName, qty, , balanceToday]) => {
      const warnings = findRecipeQuantityWarnings(menuName, [
        line('s1', qty, stockName, balanceToday),
      ])
      return `${menuName}=${warnings[0]?.code ?? 'NONE'}`
    })

    expect(actual).toEqual([
      'Wedge biscuits=exceeds_on_hand',
      'Powerade=NONE',
      'Sausage roll=equals_on_hand',
      'Popcorn=equals_on_hand',
      'Mckane dry lemon=equals_on_hand',
      'Mckane lemonade=equals_on_hand',
      'Mckane soda water=equals_on_hand',
      'Mckane tonic water=equals_on_hand',
      'Single brownie=equals_on_hand',
    ])
  })
})

describe('findRecipeQuantityWarnings — recipes that are correct and must stay silent', () => {
  it('says nothing about the twenty-five Mingle recipes already corrected to 1', () => {
    // A sample of the corrected rows, with their real balances.
    const corrected: Array<[string, string, number, number]> = [
      ['Coke', 'Coke', 1, 100],
      ['Sprite', 'Sprite', 1, 68],
      ['Fruit sticks', 'Fruit sticks', 1, 8],
      ['Still water 500ml', 'Still water x 500ml', 1, 24],
      ['Cappy juice', 'Cappy juice', 1, 39],
      ['Pizza', 'Pizza', 1, 12],
    ]

    for (const [menuName, stockName, qty, balance] of corrected) {
      expect(
        findRecipeQuantityWarnings(menuName, [line('s1', qty, stockName, balance)]),
      ).toEqual([])
    }
  })

  it('says nothing about Digi Cofee, whose fractional per-serving amounts are correct', () => {
    // Cappucino: 30 g beans, 0.05 kg sugar, 0.3 L milk — a genuine multi-ingredient recipe.
    const cappucino = [
      line('beans', 30, 'Coffee beans', 9970),
      line('sugar', 0.05, 'Suger', 9.55),
      line('milk', 0.3, 'Milk', 99.7),
    ]
    expect(findRecipeQuantityWarnings('Cappucino', cappucino)).toEqual([])
  })

  it('says nothing about FNB ChowNow Chicken Wings, where 5 per portion is real', () => {
    // This is the case that disproved the naive rule "a 1:1 name match must carry quantity 1".
    // FNB ChowNow received 50 wings on 07-06 and has sold three portions at -5 each, balance 35
    // and never negative. The stock item is counted in wings; the menu item is sold in portions;
    // the names being equal says nothing about the units. Warning here would be wrong.
    const warnings = findRecipeQuantityWarnings('Chicken Wings', [
      line('w1', 5, 'Chicken Wings', 35),
    ])
    expect(warnings).toEqual([])
  })

  it('does not use the one-to-one signal on a multi-ingredient recipe', () => {
    // Mingle's "Bacon, cheese, tomato Croissant" consumes a Croissant among other things.
    // The croissant line is 1:1 by name with nothing, and multi-line recipes carry no
    // expectation that any single quantity is 1.
    const warnings = findRecipeQuantityWarnings('Croissant', [
      line('c1', 2, 'Croissant', 500),
      line('b1', 3, 'Bacon', 500),
    ])
    expect(codesByItem(warnings)).toEqual([])
  })
})

describe('findRecipeQuantityWarnings — inputs it must not guess at', () => {
  it('ignores a line with no stock item chosen yet', () => {
    expect(findRecipeQuantityWarnings('Coke', [line('', 12, 'Coke', 12)])).toEqual([])
  })

  it('ignores blank and non-numeric quantities rather than reading them as zero', () => {
    expect(findRecipeQuantityWarnings('Coke', [line('s1', '', 'Coke', 12)])).toEqual([])
    expect(findRecipeQuantityWarnings('Coke', [line('s1', 'abc', 'Coke', 12)])).toEqual([])
  })

  it('ignores a zero or negative quantity', () => {
    expect(findRecipeQuantityWarnings('Coke', [line('s1', 0, 'Coke', 12)])).toEqual([])
    expect(findRecipeQuantityWarnings('Coke', [line('s1', -5, 'Coke', 12)])).toEqual([])
  })

  it('suppresses the balance signals entirely when the surface has no balances', () => {
    // A surface that does not load balances must not have every line read as "balance 0".
    // Sausage roll 20 is a real miskey, but without a balance only the 1:1 shape can say so.
    const noBalance = findRecipeQuantityWarnings('Sausage roll', [
      { stockItemId: 's1', quantity: 20, stockItemName: 'Sausage roll' },
    ])
    expect(codesByItem(noBalance)).toEqual(['s1:one_to_one_not_single'])

    // And with no name either, there is nothing left to go on.
    expect(findRecipeQuantityWarnings('Sausage roll', [{ stockItemId: 's1', quantity: 20 }])).toEqual(
      [],
    )
  })

  it('does not use the one-to-one signal on a multi-ingredient recipe, balances or not', () => {
    // The fallback signal is reachable only where balances are absent, so the single-ingredient
    // requirement has to hold there too. A croissant that consumes a croissant AND bacon carries
    // no expectation that either quantity is 1.
    const warnings = findRecipeQuantityWarnings('Croissant', [
      { stockItemId: 'c1', quantity: 2, stockItemName: 'Croissant' },
      { stockItemId: 'b1', quantity: 3, stockItemName: 'Bacon' },
    ])
    expect(codesByItem(warnings)).toEqual([])
  })

  it('treats near-miss names as different things rather than matching loosely', () => {
    // Mingle stocks "Sprite" and "Sprite 0" as separate items. Matching on substrings would read
    // those two as the same thing and warn about a perfectly deliberate link. Only an exact
    // match, once case and punctuation are set aside, establishes "this IS that".
    const nearMiss = findRecipeQuantityWarnings('Sprite 0', [
      { stockItemId: 's1', quantity: 12, stockItemName: 'Sprite' },
    ])
    expect(codesByItem(nearMiss)).toEqual([])

    // The same item written differently still matches: "Brownies pack" / "Brownies, pack".
    const punctuation = findRecipeQuantityWarnings('Brownies pack', [
      { stockItemId: 's1', quantity: 5, stockItemName: 'Brownies, pack' },
    ])
    expect(codesByItem(punctuation)).toEqual(['s1:one_to_one_not_single'])
  })

  it('does not fire equals_on_hand on a quantity of 1 against a balance of 1', () => {
    // One left on the shelf and one consumed per sale is the correct state, not a miskey.
    expect(findRecipeQuantityWarnings('Coke', [line('s1', 1, 'Coke', 1)])).toEqual([])
  })

  it('reports at most one warning per line', () => {
    // Sausage roll 20 against a balance of 20 satisfies equals_on_hand AND the 1:1 shape.
    const warnings = findRecipeQuantityWarnings('Sausage roll', [
      line('s1', 20, 'Sausage roll', 20),
    ])
    expect(codesByItem(warnings)).toEqual(['s1:equals_on_hand'])
  })

  it('reports every offending line when a recipe has several', () => {
    const warnings = findRecipeQuantityWarnings('Platter', [
      line('a', 12, 'Biltong', 12),
      line('b', 1, 'Droe wors', 40),
      line('c', 99, 'Chili bites', 5),
    ])
    expect(codesByItem(warnings)).toEqual(['a:equals_on_hand', 'c:exceeds_on_hand'])
  })
})
