/** #117 — variant undercharge, against PRODUCTION. READ ONLY. Items live as JSON on orders.items. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/')
const { Client } = require('pg')
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
function secret(n){for(const l of readFileSync(ENV_FILE,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);if(m&&m[1]===n)return m[2].trim().replace(/^["']|["']$/g,'')}return ''}
const db = new Client({host:'aws-0-eu-west-1.pooler.supabase.com',port:5432,user:'postgres.ihlmmpmolnpchzgwyhgh',password:secret('SUPABASE_DB_PASSWORD_PROD'),database:'postgres',ssl:{rejectUnauthorized:false}})
const q = async (s,p=[]) => (await db.query(s,p)).rows
await db.connect()
try {
  // Menu items whose variant prices are NOT all equal to base_price: these are the only ones
  // that CAN undercharge. Build the map first.
  const mi = await q(`SELECT id, name, base_price::numeric bp, variants, variant_groups FROM menu_items
                       WHERE (variants IS NOT NULL AND variants::text NOT IN ('null','[]','{}'))
                          OR (variant_groups IS NOT NULL AND variant_groups::text NOT IN ('null','[]','{}'))`)
  const priced = new Map()
  for (const r of mi) {
    const prices = []
    const walk = (x) => { if (Array.isArray(x)) x.forEach(walk)
      else if (x && typeof x === 'object') { const p = Number(x.price); if (Number.isFinite(p) && p > 0) prices.push({ n: String(x.name ?? ''), p }); Object.values(x).forEach(walk) } }
    for (const src of [r.variants, r.variant_groups]) { try { walk(typeof src === 'string' ? JSON.parse(src) : src) } catch {} }
    const above = prices.filter((x) => x.p > Number(r.bp))
    if (above.length) priced.set(r.id, { name: r.name, bp: Number(r.bp), above })
  }
  console.log(`CONTROL: ${mi.length} menu items carry variant data; ${priced.size} have a variant priced ABOVE base_price.`)
  console.log('         Only those can undercharge. If this is 0 the probe cannot find anything and proves nothing.')
  for (const [, v] of [...priced].slice(0, 8))
    console.log(`   ${v.name.slice(0,30).padEnd(30)} base=${v.bp}  higher variants=[${v.above.map(a=>`${a.n}:${a.p}`).join(', ')}]`)
  if (!priced.size) { console.log('\nNOTHING TO FIND'); process.exit(0) }

  const orders = await q(`SELECT order_number, placed_at, total::numeric, items, restaurant_id
                            FROM orders WHERE items IS NOT NULL ORDER BY placed_at DESC LIMIT 4000`)
  console.log(`\nscanned ${orders.length} most recent orders that carry an items payload`)
  let hits = [], lines = 0, variantLines = 0
  for (const o of orders) {
    let items; try { items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items } catch { continue }
    if (!Array.isArray(items)) continue
    for (const it of items) {
      lines++
      const id = it.menu_item_id ?? it.menuItemId ?? it.id
      const m = priced.get(id); if (!m) continue
      variantLines++
      const charged = Number(it.price ?? it.unit_price ?? it.unitPrice)
      if (!Number.isFinite(charged)) continue
      const label = JSON.stringify(it.selected_variants ?? it.selectedVariants ?? it.variants ?? it.name ?? '')
      const expected = m.above.find((a) => a.n && label.toLowerCase().includes(a.n.toLowerCase()))
      if (expected && charged < expected.p)
        hits.push({ o: o.order_number, at: o.placed_at, name: m.name, want: expected.p, got: charged, lost: expected.p - charged, label })
    }
  }
  console.log(`  ${lines} order lines, ${variantLines} of them on an item with a higher-priced variant`)
  console.log(`\nUNDERCHARGED LINES: ${hits.length}`)
  for (const h of hits.slice(0, 20))
    console.log(`   #${h.o} ${String(h.at?.toISOString?.().slice(0,10))} ${h.name.slice(0,24).padEnd(24)} charged ${h.got} should be ${h.want}  (-${h.lost})  ${h.label.slice(0,60)}`)
  if (hits.length) console.log(`\n   TOTAL UNDERCHARGED: N$${hits.reduce((s,h)=>s+h.lost,0).toFixed(2)} across ${hits.length} lines`)
  console.log('\nPROBE_OK')
} finally { await db.end().catch(()=>{}) }
