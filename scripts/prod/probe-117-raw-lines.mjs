/** #117 — the 11 in-scope lines, printed raw. The label-matching version returned a VACUOUS zero
 *  because every variant `name` on production is an empty string, so no label could ever match. */
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
  const mi = await q(`SELECT id, name, base_price::numeric bp, variants, variant_groups FROM menu_items
                       WHERE (variants IS NOT NULL AND variants::text NOT IN ('null','[]','{}'))
                          OR (variant_groups IS NOT NULL AND variant_groups::text NOT IN ('null','[]','{}'))`)
  const map = new Map()
  for (const r of mi) {
    const prices = []
    const walk = (x)=>{ if(Array.isArray(x)) x.forEach(walk)
      else if(x&&typeof x==='object'){ const p=Number(x.price); if(Number.isFinite(p)&&p>0) prices.push(p); Object.values(x).forEach(walk) } }
    for (const s of [r.variants, r.variant_groups]) { try { walk(typeof s==='string'?JSON.parse(s):s) } catch {} }
    if (prices.some(p=>p>Number(r.bp))) map.set(r.id,{name:r.name,bp:Number(r.bp),max:Math.max(...prices),all:[...new Set(prices)].sort((a,b)=>a-b)})
  }
  console.log('RAW VARIANT JSON for one affected item (to show what the pricer would have to read):')
  const one = mi.find(r=>map.has(r.id))
  console.log('  ', JSON.stringify(one.variants).slice(0,400))
  const orders = await q(`SELECT order_number, placed_at, items FROM orders WHERE items IS NOT NULL ORDER BY placed_at DESC LIMIT 4000`)
  console.log('\nEVERY in-scope line, raw:')
  let n=0, lost=0
  for (const o of orders) {
    let items; try { items = typeof o.items==='string'?JSON.parse(o.items):o.items } catch { continue }
    if (!Array.isArray(items)) continue
    for (const it of items) {
      const m = map.get(it.menu_item_id ?? it.menuItemId ?? it.id); if (!m) continue
      n++
      const charged = Number(it.price ?? it.unit_price ?? it.unitPrice)
      const atBase = charged === m.bp
      const sel = JSON.stringify({ name: it.name, sel: it.selected_variants ?? it.selectedVariants ?? it.variants ?? it.selectedOptions ?? null }).slice(0,110)
      if (atBase && m.max > m.bp) lost += 0 // only a real loss if a HIGHER variant was actually chosen
      console.log(`  #${o.order_number} ${String(o.placed_at?.toISOString?.().slice(0,10))} ${m.name.slice(0,20).padEnd(20)} charged=${String(charged).padStart(5)} base=${String(m.bp).padStart(5)} variantPrices=[${m.all.join(',')}]${atBase?'  <-AT BASE':''}`)
      console.log(`        selection: ${sel}`)
    }
  }
  console.log(`\n  ${n} in-scope lines shown.`)
  console.log('  A line is only an UNDERCHARGE if its selection names a higher-priced variant.')
  console.log('  If every "selection" above is null/empty, then no customer ever chose a variant,')
  console.log('  which is #200 (the groups are dropped unread) and NOT a pricing loss.')
  console.log('\nPROBE_OK')
} finally { await db.end().catch(()=>{}) }
