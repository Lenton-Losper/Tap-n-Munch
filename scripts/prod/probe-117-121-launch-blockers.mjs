/**
 * #121 and #117 against PRODUCTION. READ ONLY.
 *
 * Both are still present in the deployed tree at 84e14e4. Present in code is not the same as
 * biting customers, so this asks production directly.
 *
 *   #121  cash "Ready to Pay" writes direct-to-DB with the anon key. If the anon UPDATE policy
 *         really rejects it, NO cash order anywhere has ever had customer_ready_to_pay set.
 *         A single one that does would disprove the issue.
 *
 *   #117  the pricer selects `id, name, base_price, sizes, addons, tax_rate_id, status` and never
 *         reads variant pricing. If that undercharges, orders carrying a variant label will be
 *         priced at the item's base_price rather than the variant's absolute price.
 *
 * POSITIVE CONTROLS for both, because "found nothing" is the answer that would close an issue.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
function secret(name) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}
const db = new Client({
  host: 'aws-0-eu-west-1.pooler.supabase.com', port: 5432,
  user: `postgres.${PROD_REF}`, password: secret('SUPABASE_DB_PASSWORD_PROD'),
  database: 'postgres', ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

await db.connect()
try {
  console.log('='.repeat(78))
  console.log('#121 — is the cash "Ready to Pay" button dead?')
  console.log('='.repeat(78))

  console.log('\nCONTROL: the column is readable and the table is non-empty.')
  const [tot] = await q(`SELECT count(*)::int n, count(*) FILTER (WHERE customer_ready_to_pay) ::int flagged FROM orders`)
  console.log(`  orders total=${tot.n}   customer_ready_to_pay=true on ${tot.flagged}`)
  if (tot.n === 0) { console.log('  *** no orders at all — this probe proves nothing ***'); process.exit(2) }

  const byMethod = await q(
    `SELECT COALESCE(payment_method,'(null)') m, count(*)::int n,
            count(*) FILTER (WHERE customer_ready_to_pay)::int flagged
       FROM orders GROUP BY 1 ORDER BY 2 DESC`)
  console.log('\n  flagged, split by payment_method — #121 says CASH must be 0:')
  for (const r of byMethod) console.log(`    ${String(r.m).padEnd(14)} ${String(r.n).padStart(5)} orders   ${String(r.flagged).padStart(4)} flagged`)

  const cashFlagged = await q(
    `SELECT order_number, payment_method, status, placed_at
       FROM orders WHERE customer_ready_to_pay AND payment_method = 'cash'
       ORDER BY placed_at DESC LIMIT 5`)
  console.log(`\n  cash orders that DID get flagged: ${cashFlagged.length}`)
  for (const r of cashFlagged) console.log(`    #${r.order_number} ${r.status} ${r.placed_at?.toISOString?.() ?? r.placed_at}`)

  const pol = await q(
    `SELECT polname, pg_get_expr(polwithcheck, polrelid) wc, pg_get_expr(polqual, polrelid) qual
       FROM pg_policy WHERE polrelid = 'public.orders'::regclass ORDER BY polname`)
  console.log(`\n  UPDATE policies on public.orders (${pol.length} policies total):`)
  for (const p of pol) if (p.wc) console.log(`    ${p.polname}\n        WITH CHECK ${p.wc}`)

  console.log('\n' + '='.repeat(78))
  console.log('#117 — does variant pricing undercharge?')
  console.log('='.repeat(78))

  console.log('\nCONTROL: variant groups with absolute prices actually exist on production.')
  const vg = await q(
    `SELECT count(*)::int items,
            count(*) FILTER (WHERE variants IS NOT NULL AND variants::text NOT IN ('null','[]','{}'))::int with_variants,
            count(*) FILTER (WHERE variant_groups IS NOT NULL AND variant_groups::text NOT IN ('null','[]','{}'))::int with_groups
       FROM menu_items`)
  console.log(`  menu_items=${vg[0].items}  with variants=${vg[0].with_variants}  with variant_groups=${vg[0].with_groups}`)

  const sample = await q(
    `SELECT name, base_price, variants
       FROM menu_items
      WHERE variants IS NOT NULL AND variants::text NOT IN ('null','[]','{}')
      ORDER BY name LIMIT 6`)
  console.log('\n  sample priced variants vs base_price:')
  for (const r of sample) {
    let prices = []
    try {
      const v = typeof r.variants === 'string' ? JSON.parse(r.variants) : r.variants
      const walk = (x) => { if (Array.isArray(x)) x.forEach(walk)
        else if (x && typeof x === 'object') { if (typeof x.price === 'number') prices.push(x.price); Object.values(x).forEach(walk) } }
      walk(v)
    } catch {}
    const uniq = [...new Set(prices)].sort((a,b)=>a-b)
    const flag = uniq.length && uniq.some((p) => Number(p) !== Number(r.base_price)) ? '  <- differs from base' : ''
    console.log(`    ${String(r.name).slice(0,34).padEnd(34)} base=${String(r.base_price).padStart(7)}  variant prices=[${uniq.join(', ')}]${flag}`)
  }

  console.log('\n  ORDER ITEMS carrying a variant label, charged vs the menu base_price:')
  const under = await q(
    `SELECT oi.name, oi.price::numeric charged, mi.base_price::numeric base, count(*)::int n
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.name ~* '(large|small|medium|regular|double|single)'
      GROUP BY 1,2,3 ORDER BY n DESC LIMIT 12`)
  if (!under.length) console.log('    none — no ordered item name carries a size word')
  for (const r of under)
    console.log(`    ${String(r.name).slice(0,40).padEnd(40)} charged=${String(r.charged).padStart(7)} base=${String(r.base).padStart(7)} x${r.n}${Number(r.charged)===Number(r.base)?'  <- charged AT BASE':''}`)

  console.log('\nPROBE_OK')
} finally { await db.end().catch(()=>{}) }
