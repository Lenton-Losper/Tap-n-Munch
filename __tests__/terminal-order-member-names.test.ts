/**
 * Binds to lib/tabs/resolve-order-member-names.ts (#288).
 *
 * THE TEST THAT CARRIES THE FILE is `never invents an owner`. The terminal is about to charge
 * somebody: putting one diner's food under another diner's name is worse than the "Guest" this
 * replaces, and a lookup that fell back to "the first member" or "the most recent member" would
 * do exactly that while looking correct on a table where everyone happens to have ordered.
 *
 * The second one is `an empty display name does not suppress the terminal's fallback` — mapping
 * a member with no name to `''` would render a blank headline instead of "Guest", which is a
 * regression dressed as a fix.
 */
import {
  buildMemberNameLookup,
  resolveOrderMemberName,
} from '@/lib/tabs/resolve-order-member-names'

const MEMBERS = [
  { session_id: 'sess-lenton', display_name: 'Lenton', joined_at: '2026-08-16T00:00:00Z' },
  { session_id: 'sess-bob', display_name: 'Bob', joined_at: '2026-08-16T00:05:00Z' },
]

describe('buildMemberNameLookup', () => {
  it('maps each member session id to their name', () => {
    const lookup = buildMemberNameLookup(MEMBERS)
    expect(lookup.get('sess-lenton')).toBe('Lenton')
    expect(lookup.get('sess-bob')).toBe('Bob')
  })

  it('an empty display name does not suppress the terminal fallback', () => {
    // Mapping to '' would render a blank headline, because the terminal's guard is
    // `{item.member_name || 'Guest'}` and '' is falsy only by luck of that operator -- but a
    // null is what the contract here promises, so the member is skipped entirely.
    const lookup = buildMemberNameLookup([{ session_id: 'sess-x', display_name: '   ' }])
    expect(lookup.has('sess-x')).toBe(false)
  })

  it('skips a member with no session id rather than keying on empty string', () => {
    const lookup = buildMemberNameLookup([{ display_name: 'Ghost' }])
    expect(lookup.size).toBe(0)
  })

  it.each([null, undefined, 'not an array', {}, 42])('survives %p in the members column', (m) => {
    expect(buildMemberNameLookup(m as never).size).toBe(0)
  })
})

describe('resolveOrderMemberName', () => {
  const lookup = buildMemberNameLookup(MEMBERS)

  it('resolves member_session_id first', () => {
    expect(
      resolveOrderMemberName({ member_session_id: 'sess-bob', session_id: 'sess-lenton' }, lookup)
    ).toBe('Bob')
  })

  it('falls back to session_id, the same precedence every other surface applies', () => {
    expect(resolveOrderMemberName({ session_id: 'sess-lenton' }, lookup)).toBe('Lenton')
  })

  it('NEVER invents an owner for an unmatched order', () => {
    // An order placed before its placer joined, or by a member since removed. The terminal is
    // about to charge somebody -- guessing puts one diner's food under another diner's name.
    expect(resolveOrderMemberName({ member_session_id: 'sess-nobody' }, lookup)).toBeNull()
    expect(resolveOrderMemberName({ member_session_id: '' }, lookup)).toBeNull()
    expect(resolveOrderMemberName({}, lookup)).toBeNull()
  })

  it('returns null rather than the first member when the tab has members', () => {
    // The specific wrong implementation this guards against: `lookup.values().next().value`.
    const result = resolveOrderMemberName({ member_session_id: 'sess-stranger' }, lookup)
    expect(result).not.toBe('Lenton')
    expect(result).toBeNull()
  })

  it('returns null against an empty lookup without throwing', () => {
    expect(resolveOrderMemberName({ member_session_id: 'sess-lenton' }, new Map())).toBeNull()
  })
})
