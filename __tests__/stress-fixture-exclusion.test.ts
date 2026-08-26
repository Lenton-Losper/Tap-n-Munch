/**
 * THE STRESS-FIXTURE EXCLUSION — the rule that keeps 37.4% of the orders table out of every
 * platform-wide number.
 *
 * THE TEST THAT MATTERS is 'a row with BOTH ids null is kept'. Everything else here exists so that
 * one cannot be satisfied trivially: a predicate that returned false for everything would keep that
 * row too, and would exclude nothing at all.
 *
 * WHY THAT ONE. The rule is `restaurant_id IS NULL AND firebase_restaurant_id LIKE
 * 'restaurant_test_%'`, and its negation written with two clauses drops a row whose two ids are
 * BOTH null, because `NULL NOT LIKE '...'` is NULL rather than TRUE. Production has exactly one
 * such row and it is a real order. The PostgREST filter's third clause is what keeps it, and
 * `scripts/prod/verify-stress-fixture-exclusion-20260826.ts` proves that against production by id —
 * removing the clause turns three of its assertions red. These tests pin the JS side of the same
 * rule so a refactor cannot drift the two apart without CI noticing.
 */
import {
  STRESS_FIXTURE_EXCLUSION_OR,
  STRESS_FIXTURE_EXCLUSION_SQL,
  STRESS_FIXTURE_FIREBASE_PREFIX,
  countStressFixtures,
  excludeStressFixtures,
  isStressFixtureOrder,
  withoutStressFixtures,
} from '@/lib/orders/stress-fixtures'

const FIXTURE = { restaurant_id: null, firebase_restaurant_id: 'restaurant_test_03' }
const REAL = { restaurant_id: 'b0f1e2d3-0000-4000-8000-000000000001', firebase_restaurant_id: null }
const ORPHAN = { restaurant_id: null, firebase_restaurant_id: null }

describe('isStressFixtureOrder — both conditions are required', () => {
  it('a stress fixture is one', () => {
    expect(isStressFixtureOrder(FIXTURE)).toBe(true)
    for (let n = 1; n <= 10; n++) {
      const id = `restaurant_test_${String(n).padStart(2, '0')}`
      expect(isStressFixtureOrder({ restaurant_id: null, firebase_restaurant_id: id })).toBe(true)
    }
  })

  it('a real order is not, whatever it is named', () => {
    expect(isStressFixtureOrder(REAL)).toBe(false)
    // The half that matters: a REAL restaurant_id wins even against a stress-looking firebase id.
    // A row that belongs to a venue is that venue's revenue and is never ours to drop.
    expect(
      isStressFixtureOrder({
        restaurant_id: REAL.restaurant_id,
        firebase_restaurant_id: 'restaurant_test_03',
      }),
    ).toBe(false)
  })

  it('a NULL restaurant_id ALONE is not enough', () => {
    // Production's one non-fixture orphan. #324's own probe partitions on exactly this line.
    expect(isStressFixtureOrder(ORPHAN)).toBe(false)
    expect(
      isStressFixtureOrder({ restaurant_id: null, firebase_restaurant_id: 'some-real-firebase-id' }),
    ).toBe(false)
  })

  it('an explicit undefined is treated as null', () => {
    // Present-but-undefined is a value, not a missing column, and PostgREST can produce it.
    expect(
      isStressFixtureOrder({ restaurant_id: undefined, firebase_restaurant_id: 'restaurant_test_05' }),
    ).toBe(true)
    expect(
      isStressFixtureOrder({ restaurant_id: REAL.restaurant_id, firebase_restaurant_id: undefined }),
    ).toBe(false)
  })
})

/**
 * THE GUARD THAT MATTERS MOST, because the alternative already happened.
 *
 * `measure-customer-wait-20260825.ts` selects thirteen columns and firebase_restaurant_id is not
 * one of them. With a permissive predicate it printed `stress fixtures excluded: 0 of 3516` and
 * reported exactly the same wrong 1358 QR orders it reported before the exclusion existed. A filter
 * that runs, reports zero and changes nothing reads as CONFIRMATION that the data is clean — and it
 * fails in the reassuring direction, which is the direction nobody re-derives.
 */
describe('a row missing the columns THROWS rather than answering false', () => {
  it('throws when firebase_restaurant_id was not selected', () => {
    expect(() => isStressFixtureOrder({ restaurant_id: null })).toThrow(
      /firebase_restaurant_id/,
    )
  })

  it('throws when restaurant_id was not selected', () => {
    expect(() => isStressFixtureOrder({ firebase_restaurant_id: 'restaurant_test_05' })).toThrow(
      /restaurant_id/,
    )
  })

  it('throws when neither was selected, naming both', () => {
    const run = () => isStressFixtureOrder({})
    expect(run).toThrow(/restaurant_id/)
    expect(run).toThrow(/firebase_restaurant_id/)
  })

  it('the message says what to do about it', () => {
    expect(() => isStressFixtureOrder({ restaurant_id: null })).toThrow(/Add .* to the select/)
  })

  it('does NOT throw when the columns are present and null', () => {
    // The distinction the whole guard rests on: absent key vs null value.
    expect(() => isStressFixtureOrder(ORPHAN)).not.toThrow()
    expect(isStressFixtureOrder(ORPHAN)).toBe(false)
  })

  it('withoutStressFixtures propagates the throw instead of quietly keeping everything', () => {
    expect(() => withoutStressFixtures([{ restaurant_id: null }])).toThrow(
      /firebase_restaurant_id/,
    )
  })
})

describe('the prefix is matched exactly', () => {
  it('restaurant_testing_co does NOT carry the prefix', () => {
    // 'restaurant_testing_co' does not start with 'restaurant_test_' -- the underscore is part of
    // the prefix. Asserted directly so the intent is not left to a reader's eye.
    expect('restaurant_testing_co'.startsWith(STRESS_FIXTURE_FIREBASE_PREFIX)).toBe(false)
    expect(
      isStressFixtureOrder({ restaurant_id: null, firebase_restaurant_id: 'restaurant_testing_co' }),
    ).toBe(false)
  })

  it('is anchored at the start, so a suffix match is not a fixture', () => {
    expect(
      isStressFixtureOrder({ restaurant_id: null, firebase_restaurant_id: 'x-restaurant_test_01' }),
    ).toBe(false)
  })
})

describe('withoutStressFixtures / countStressFixtures', () => {
  const rows = [FIXTURE, REAL, ORPHAN, FIXTURE, REAL]

  it('drops the fixtures and keeps the rest', () => {
    expect(withoutStressFixtures(rows)).toEqual([REAL, ORPHAN, REAL])
  })

  it('a row with BOTH ids null is KEPT', () => {
    // The whole reason the PostgREST filter has three clauses.
    expect(withoutStressFixtures([ORPHAN])).toEqual([ORPHAN])
  })

  it('counts what it would drop, so a script can report it instead of excluding silently', () => {
    expect(countStressFixtures(rows)).toBe(2)
    expect(countStressFixtures(rows) + withoutStressFixtures(rows).length).toBe(rows.length)
  })

  it('an all-real list is returned intact', () => {
    // The negative control: an exclusion that dropped everything would pass every test above that
    // only asserts fixtures are gone.
    expect(withoutStressFixtures([REAL, REAL, ORPHAN])).toHaveLength(3)
  })
})

describe('the PostgREST filter', () => {
  it('has all THREE clauses', () => {
    const clauses = STRESS_FIXTURE_EXCLUSION_OR.split(',')
    expect(clauses).toEqual([
      'restaurant_id.not.is.null',
      'firebase_restaurant_id.is.null',
      'firebase_restaurant_id.not.like.restaurant_test_*',
    ])
  })

  it('keeps the null-firebase clause, which is the one a refactor loses', () => {
    expect(STRESS_FIXTURE_EXCLUSION_OR).toContain('firebase_restaurant_id.is.null')
  })

  it('interpolates nothing — .or() parses its argument, so the filter is a constant', () => {
    // `.eq()` is parser-free; `.or()` is not. A caller-supplied fragment here would be an
    // injection seam of the #242/#254 class. Nothing about this filter varies.
    expect(typeof STRESS_FIXTURE_EXCLUSION_OR).toBe('string')
    expect(STRESS_FIXTURE_EXCLUSION_OR).not.toMatch(/\$\{/)
  })

  it('excludeStressFixtures applies exactly that filter and returns the builder', () => {
    const seen: string[] = []
    const builder = { or(f: string) { seen.push(f); return builder } }
    expect(excludeStressFixtures(builder)).toBe(builder)
    expect(seen).toEqual([STRESS_FIXTURE_EXCLUSION_OR])
  })
})

describe('the SQL form says the same thing', () => {
  it('is the negation of the two-condition rule', () => {
    expect(STRESS_FIXTURE_EXCLUSION_SQL).toBe(
      "NOT (restaurant_id IS NULL AND firebase_restaurant_id LIKE 'restaurant_test_%')",
    )
  })

  it('uses the same prefix constant as the predicate', () => {
    expect(STRESS_FIXTURE_EXCLUSION_SQL).toContain(STRESS_FIXTURE_FIREBASE_PREFIX)
    expect(STRESS_FIXTURE_EXCLUSION_OR).toContain(STRESS_FIXTURE_FIREBASE_PREFIX)
  })
})
