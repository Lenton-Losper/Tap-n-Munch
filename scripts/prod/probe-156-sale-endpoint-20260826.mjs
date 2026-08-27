import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/')
const { Client } = require('pg')
const ENV='C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const sec=(n)=>{for(const l of readFileSync(ENV,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);if(m&&m[1]===n)return m[2].trim().replace(/^["']|["']$/g,'')}throw new Error(n)}
const c=new Client({host:'aws-0-eu-west-1.pooler.supabase.com',port:5432,user:'postgres.ihlmmpmolnpchzgwyhgh',password:sec('SUPABASE_DB_PASSWORD_PROD'),database:'postgres',ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000})
await c.connect()

// one real, recent, card-paid order that has NO sale row
const {rows}=await c.query(`
  WITH sale AS (SELECT DISTINCT unnest(order_ids)::text AS oid FROM payment_events WHERE event_type='sale')
  SELECT o.id, o.order_number, o.total, o.restaurant_id, r.name,
         o.paycloud_merchant_order_no, o.payment_voucher_no, o.paid_at,
         t.id AS terminal_id
    FROM orders o JOIN restaurants r ON r.id=o.restaurant_id
    LEFT JOIN sale ON sale.oid = o.id::text
    LEFT JOIN LATERAL (SELECT id FROM restaurant_terminals WHERE restaurant_id=o.restaurant_id AND active LIMIT 1) t ON true
   WHERE o.restaurant_id IS NOT NULL AND o.payment_status='paid'
     AND lower(coalesce(o.payment_method,'card'))='card'
     AND o.paycloud_merchant_order_no IS NOT NULL AND o.payment_voucher_no IS NOT NULL
     AND sale.oid IS NULL
   ORDER BY o.paid_at DESC LIMIT 1`)
if(!rows.length){ console.log('no candidate order'); process.exit(0) }
const o=rows[0]
console.log('SUBJECT: order #'+o.order_number+'  '+o.name+'  N$'+o.total)
console.log('  business_order_no: '+o.paycloud_merchant_order_no)
console.log('  voucher:           '+o.payment_voucher_no)
console.log('  paid_at:           '+o.paid_at)
console.log('  terminal:          '+(o.terminal_id??'(none active)'))

// mint the same JWT signTerminalJwt produces
const { SignJWT } = await import('jose')
const secret = new TextEncoder().encode(sec('TERMINAL_JWT_SECRET'))
const token = await new SignJWT({
  type:'terminal', restaurant_id:String(o.restaurant_id), device_serial:'probe-156',
  permissions:['orders:read','orders:update','tables:read'],
}).setSubject(String(o.terminal_id??'probe')).setProtectedHeader({alg:'HS256'}).setExpirationTime('5m').sign(secret)

const body = {
  order_ids: [String(o.id)],
  business_order_no: String(o.paycloud_merchant_order_no),
  transaction_id: String(o.payment_voucher_no),
  amount: Number(o.total),
}
console.log('\nPOST /api/terminal/payment-events/sale')
console.log('  body: '+JSON.stringify(body))
const res = await fetch('https://flashtap.app/api/terminal/payment-events/sale', {
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
  body: JSON.stringify(body),
})
const text = await res.text()
console.log('\n================ RESPONSE ================')
console.log('  HTTP '+res.status)
console.log('  '+text.slice(0,600))
console.log('==========================================')
await c.end()
