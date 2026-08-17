/**
 * OFFLINE. No network, no credentials, no database. Demonstrates WHY #242's fix is a
 * reformulation rather than a validator, by printing the URLs postgrest-js actually builds.
 *
 *   npx tsx scripts/postgrest-or-vs-eq-parser-probe.ts
 *
 * `.or()` is dangerous because PostgREST PARSES the argument of `or=(...)`: the comma is its
 * term separator, so two terms become four and the extra ones are the caller's. `.eq()` has no
 * such position — the grammar is `<column>=<operator>.<value>`, we supply the column and the
 * operator, and the whole remainder is one opaque value in which no second column name can
 * appear. That is the entire argument for the fix, and it is visible in the query string.
 */
import { PostgrestClient } from '@supabase/postgrest-js'

const client = new PostgrestClient('http://example.invalid/rest/v1')

const BENIGN = 'NONEXISTENT-REF-ZZZZZZ'
const INJECTED = 'NONEXISTENT-REF-ZZZZZZ,id.not.is.null'

/** The expression this repo used before #242, verbatim. */
const orExpression = (mo: string) => `paycloud_merchant_order_no.eq.${mo},payment_reference.eq.${mo}`

function show(label: string, builder: { url: URL }) {
  const url = String(builder.url)
  console.log(`\n${label}`)
  console.log(`  decoded : ${decodeURIComponent(url)}`)
  console.log(`  on wire : ${url}`)
}

show(
  'BEFORE  .or()  benign — 2 OR terms, which is correct',
  client.from('orders').select('id').or(orExpression(BENIGN)) as unknown as { url: URL },
)
show(
  'BEFORE  .or()  INJECTED — 4 OR terms, and 2 of them are the caller’s',
  client.from('orders').select('id').or(orExpression(INJECTED)) as unknown as { url: URL },
)
show(
  'AFTER   .eq()  benign',
  client.from('orders').select('id').eq('paycloud_merchant_order_no', BENIGN) as unknown as { url: URL },
)
show(
  'AFTER   .eq()  INJECTED — one opaque value; the comma is percent-encoded and separates nothing',
  client.from('orders').select('id').eq('paycloud_merchant_order_no', INJECTED) as unknown as { url: URL },
)

console.log(
  '\nThe injected predicate survives into the query only in the .or() form. In the .eq() form there\n' +
    'is no grammatical position for it, which is why the fix needs no charset assumption about\n' +
    "Finatic's out_trade_no.",
)
