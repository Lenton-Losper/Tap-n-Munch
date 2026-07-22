import { createClient } from '@supabase/supabase-js'
import { PDFDocument } from 'pdf-lib'
import fs from 'fs'
import path from 'path'
import { generatePdfBytes } from '../lib/reports/generate-pdf-lib'
import { getReportData } from '../lib/reports/get-report-data'
import { generateCsv } from '../lib/reports/generate-csv'

const STAGING_RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OUT_DIR = path.join(process.cwd(), 'supabase/.temp/pdf-verify-output')

function loadEnv(file: string) {
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        let v = l.slice(i + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          v = v.slice(1, -1)
        return [l.slice(0, i).trim(), v]
      }),
  )
}

async function main() {
  const env = loadEnv('.env.test')
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const today = new Date().toISOString().slice(0, 10)
  const testOrderIds: string[] = []

  const maxOrder = await admin
    .from('orders')
    .select('order_number')
    .eq('restaurant_id', STAGING_RESTAURANT)
    .order('order_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  let nextOrderNo = (maxOrder.data?.order_number ?? 0) + 1

  fs.mkdirSync(OUT_DIR, { recursive: true })

  const small = await getReportData({
    restaurantId: STAGING_RESTAURANT,
    startDate: today,
    endDate: today,
  })
  const smallBytes = await generatePdfBytes(small)
  const smallDoc = await PDFDocument.load(smallBytes)
  fs.writeFileSync(path.join(OUT_DIR, 'small-report.pdf'), smallBytes)

  const rows = Array.from({ length: 35 }, (_, i) => ({
    restaurant_id: STAGING_RESTAURANT,
    status: 'completed',
    payment_status: 'paid',
    order_number: nextOrderNo + i,
    table_number: (i % 8) + 1,
    customer_name: i % 4 === 0 ? `PDF Test Guest ${i + 1}` : null,
    items: [
      {
        name:
          i % 6 === 0
            ? 'Grilled chicken wrap with chips and a very long special instruction note'
            : 'Cappuccino',
        quantity: 1 + (i % 3),
        price: 35 + i,
      },
    ],
    total: 35 + i,
    payment_method: i % 2 === 0 ? 'card' : 'cash',
    payment_channel: 'pos',
    is_closed: true,
    placed_at: new Date(Date.now() - i * 60_000).toISOString(),
  }))
  nextOrderNo += 35

  const { data: inserted, error: insertErr } = await admin.from('orders').insert(rows).select('id')
  if (insertErr) throw insertErr
  testOrderIds.push(...(inserted ?? []).map((r) => r.id))

  const large = await getReportData({
    restaurantId: STAGING_RESTAURANT,
    startDate: today,
    endDate: today,
  })
  const largeBytes = await generatePdfBytes(large)
  const largeDoc = await PDFDocument.load(largeBytes)
  fs.writeFileSync(path.join(OUT_DIR, 'large-report.pdf'), largeBytes)

  const csv = generateCsv(small)

  if (testOrderIds.length > 0) {
    await admin.from('orders').delete().in('id', testOrderIds)
  }

  console.log(
    JSON.stringify(
      {
        outDir: OUT_DIR,
        small: {
          restaurant: small.restaurant.name,
          orders: small.orders.length,
          pages: smallDoc.getPageCount(),
          bytes: smallBytes.length,
        },
        large: {
          orders: large.orders.length,
          pages: largeDoc.getPageCount(),
          bytes: largeBytes.length,
          disposableOrdersCreated: 35,
          disposableOrdersDeleted: testOrderIds.length,
        },
        csv: {
          startsWithFlashTap: csv.startsWith('FlashTap Order Report'),
          lineCount: csv.split('\n').length,
        },
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
