/**
 * fetchAllRowsConcurrently against the REAL postgrest-js builder (fetch replaced by a fake server).
 *
 * The in-memory PostgREST fake used elsewhere does not reproduce the hazard this function exists
 * around: postgrest-js `.range()` mutates the builder it is called on. So this suite drives the real
 * client, and its first test is the CONTROL that proves the hazard is real -- without it, "the
 * factory version returns the right rows" would prove nothing.
 */
import { PostgrestClient } from '@supabase/postgrest-js'
import { fetchAllRows, fetchAllRowsConcurrently } from '@/lib/supabase/fetch-all-rows'

const TOTAL = 4675
const ROWS = Array.from({ length: TOTAL }, (_, i) => ({ id: i }))

function fakeServer(total = TOTAL) {
  const requested: Array<[number, number]> = []
  let inFlight = 0
  let maxInFlight = 0
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const from = Number(url.searchParams.get('offset') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? total)
    requested.push([from, limit])
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
    const body = ROWS.slice(0, total).slice(from, from + limit)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': `${from}-${from + body.length - 1}/*` },
    })
  }
  const client = new PostgrestClient('http://fake.local/rest/v1', { fetch: fetchImpl as typeof fetch })
  return { client, requested, maxInFlight: () => maxInFlight }
}

const build = (client: PostgrestClient) => () => client.from('orders').select('id').order('id') as any

it('CONTROL: ranging ONE postgrest-js builder several times in a tick sends the last offset each time', async () => {
  const { client, requested } = fakeServer()
  const shared = client.from('orders').select('id').order('id') as any
  const pages = await Promise.all([0, 1000, 2000].map((o) => shared.range(o, o + 999)))
  // Every request carried offset 2000: the hazard fetchAllRowsConcurrently is shaped around.
  expect(requested.map(([from]) => from)).toEqual([2000, 2000, 2000])
  expect(pages.map((p: any) => p.data[0].id)).toEqual([2000, 2000, 2000])
})

it('returns exactly what the sequential fetchAllRows returns, in the same order', async () => {
  const seq = fakeServer()
  const expected = await fetchAllRows<{ id: number }>(build(seq.client)())
  const par = fakeServer()
  const got = await fetchAllRowsConcurrently<{ id: number }>(build(par.client), { concurrency: 6 })
  expect(expected).toHaveLength(TOTAL)
  expect(got).toEqual(expected)
  // Page 0 alone, then one wave of six (1000..6000): pages 1-4 hold data, 4 is short, 5-6 speculative.
  expect(par.requested.map(([from]) => from)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000])
  expect(par.maxInFlight()).toBe(6)
})

it('a set that fits one page costs one request', async () => {
  const s = fakeServer(300)
  const got = await fetchAllRowsConcurrently<{ id: number }>(build(s.client), {})
  expect(got).toHaveLength(300)
  expect(s.requested).toHaveLength(1)
})

it('never more than `concurrency` pages in flight', async () => {
  const s = fakeServer()
  await fetchAllRowsConcurrently<{ id: number }>(build(s.client), { concurrency: 2, pageSize: 500 })
  expect(s.maxInFlight()).toBe(2)
})

it('keeps the ceiling: throws rather than return a truncated set', async () => {
  const s = fakeServer()
  await expect(
    fetchAllRowsConcurrently<{ id: number }>(build(s.client), { maxRows: 2000, label: 'ceiling-test' }),
  ).rejects.toThrow(/ceiling-test: exceeded maxRows \(2000\)/)
})

it('a failed page fails the read, named by its label', async () => {
  const client = new PostgrestClient('http://fake.local/rest/v1', {
    fetch: (async (input: RequestInfo | URL) => {
      const from = Number(new URL(String(input)).searchParams.get('offset') ?? 0)
      if (from === 2000) return new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify(ROWS.slice(from, from + 1000)), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  await expect(fetchAllRowsConcurrently(build(client), { label: 'fail-test' })).rejects.toThrow(/fail-test: boom/)
})
