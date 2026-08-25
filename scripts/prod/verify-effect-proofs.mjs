/**
 * THE FIVE EFFECT PROOFS, against PRODUCTION's real data. READ ONLY.
 *
 * Proofs 1 and 2 are about CUSTOMER-FACING COPY at two trading venues, so they are driven by the
 * values production actually serves rather than by fixtures. The decision the cart makes is:
 *
 *   isCounterService = isKiosk || restaurant.is_counter_service === true
 *   canTakeCard      = restaurant.card_payments_available === true      <- fails CLOSED
 *   card option renders only when canTakeCard AND the venue enables card
 *   cash label/body  = isCounterService ? payCounterCash* : payTableCash*
 *   card label/body  = isCounterService ? payCounterCard* : payTableCard*
 *
 * This reproduces that expression exactly, feeds it the production row, and asserts the string a
 * customer would read. It is not a render test -- it is the decision the render is a function of,
 * which is the part that can be wrong without anyone noticing.
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

/** The signed strings, read from the shipped module rather than retyped here. */
function menuCopy() {
  const src = readFileSync('lib/customer-copy/menu-copy.ts', 'utf8')
  const out = {}
  for (const m of src.matchAll(/^\s{2}(pay(?:Counter|Table)[A-Za-z]+)\s*:\s*'([^']*)'/gm)) {
    out[m[1]] = m[2]
  }
  return out
}

let bad = 0
const check = (ok, label, detail) => {
  if (!ok) bad++
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${label}${detail ? '  ' + detail : ''}`)
}

async function main() {
  const COPY = menuCopy()
  console.log('='.repeat(78))
  console.log('EFFECT PROOFS — production data, read only')
  console.log('='.repeat(78))

  const db = new Client({
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${PROD_REF}`,
    password: secret('SUPABASE_DB_PASSWORD_PROD'),
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()

  try {
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.is_counter_service, r.card_payments_available,
              r.finatic_merchant_no, r.finatic_store_no, s.payment_methods
         FROM restaurants r
         LEFT JOIN restaurant_settings s ON s.restaurant_id = r.id
        WHERE r.name IN ('FNB ChowNow','Chownow Nedbank','Digi Cofee','Riviera')
        ORDER BY r.name`,
    )

    // The cart's own expression, reproduced.
    const decide = (r, isKiosk = false) => {
      const isCounterService = isKiosk || r.is_counter_service === true
      const canTakeCard = r.card_payments_available === true
      const methods = Array.isArray(r.payment_methods) && r.payment_methods.length ? r.payment_methods.map(String) : null
      const cardEnabled = methods ? methods.includes('card') : true
      const cashEnabled = methods ? methods.includes('cash') : true
      return {
        isCounterService,
        cardRenders: canTakeCard && cardEnabled,
        cashRenders: cashEnabled,
        cashLabel: isCounterService ? COPY.payCounterCashLabel : COPY.payTableCashLabel,
        cashBody: isCounterService ? COPY.payCounterCashBody : COPY.payTableCashBody,
        cardLabel: isCounterService ? COPY.payCounterCardLabel : COPY.payTableCardLabel,
        cardBody: isCounterService ? COPY.payCounterCardBody : COPY.payTableCardBody,
      }
    }

    console.log('\nPRODUCTION ROWS')
    for (const r of rows) {
      console.log(
        `  ${String(r.name).padEnd(18)} counter=${String(r.is_counter_service).padEnd(5)} card_available=${String(r.card_payments_available).padEnd(5)} merchant=${r.finatic_merchant_no ? 'set' : 'NULL'} methods=${JSON.stringify(r.payment_methods)}`,
      )
    }

    // ---------------------------------------------------------------- 1 + the FNB half
    const fnb = rows.find((r) => r.name === 'FNB ChowNow')
    console.log('\nPROOF 1 — FNB ChowNow: counter service AND card capable')
    if (!fnb) {
      check(false, 'FNB ChowNow row found')
    } else {
      const d = decide(fnb)
      check(d.isCounterService === true, 'is treated as counter service')
      check(d.cashBody === COPY.payCounterCashBody, 'CASH body is the COUNTER copy', `"${d.cashBody}"`)
      check(!/someone|staff|waiter/i.test(d.cashBody), 'cash copy promises NO person coming to a table')
      check(d.cardRenders === true, 'the CARD option DOES render (it can take cards)')
      check(d.cardBody === COPY.payCounterCardBody, 'CARD body is the COUNTER copy', `"${d.cardBody}"`)
      check(/counter/i.test(d.cardBody), 'card copy says COUNTER, not table')
      check(!/someone|staff|waiter/i.test(d.cardBody), 'card copy promises no person either')
    }

    // ---------------------------------------------------------------- 2 + the Nedbank half
    const ned = rows.find((r) => r.name === 'Chownow Nedbank')
    console.log('\nPROOF 2 — Chownow Nedbank: counter service, NULL credentials')
    if (!ned) {
      check(false, 'Chownow Nedbank row found')
    } else {
      const d = decide(ned)
      check(d.isCounterService === true, 'is treated as counter service')
      check(
        !ned.finatic_merchant_no || !ned.finatic_store_no,
        'genuinely has NULL Finatic credentials',
        `merchant=${ned.finatic_merchant_no ?? 'NULL'} store=${ned.finatic_store_no ?? 'NULL'}`,
      )
      check(ned.card_payments_available === false, 'card_payments_available is FALSE, derived in the database')
      check(d.cardRenders === false, 'THE CARD OPTION DOES NOT RENDER AT ALL')
      check(d.cashBody === COPY.payCounterCashBody, 'cash body is the COUNTER copy', `"${d.cashBody}"`)
      check(!/someone|staff|waiter/i.test(d.cashBody), 'no person is promised')
    }

    // ---------------------------------------------------------------- the contrast
    const riv = rows.find((r) => r.name === 'Riviera')
    console.log('\nCONTROL — Riviera: table service, card capable (the copy must DIFFER)')
    if (riv) {
      const d = decide(riv)
      check(d.isCounterService === false, 'is NOT counter service')
      check(d.cashBody === COPY.payTableCashBody, 'cash body is the TABLE copy', `"${d.cashBody}"`)
      check(/someone/i.test(d.cashBody), 'table copy DOES promise a person — that is correct here')
      const fnbD = fnb ? decide(fnb) : null
      check(
        !fnbD || fnbD.cashBody !== d.cashBody,
        'a counter venue and a table venue read DIFFERENT sentences',
        'otherwise is_counter_service does nothing',
      )
    }

    // ------------------------------------------------- ROUND TWO: the six pairs signed 2026-08-25
    //
    // Round one covered only the cart's payment chooser. These six are the strings on the tab
    // page, the v2 landing, the cart's payment explanation and the order-confirmation ready line,
    // checked the same way: against the venue rows production actually serves.
    const PAIRS = [
      ['CouldNotNotifyStaff', 'tab page: request-the-bill failed'],
      ['PleaseAskForAssistance', 'v2 landing: a payment is already in progress'],
      ['StaffNotified', 'tab page: request-the-bill succeeded'],
      ['TabReadyToPay', 'v2 landing: the tab is ready to pay'],
      ['AssistWithPayment', 'cart: how payment will happen'],
      ['OrderReady', 'order confirmation: the order is ready'],
    ]
    const PROMISES_A_PERSON = /waiter|someone|staff member|at your table|come to your table|will be with you/i

    console.log('\nPROOF 3 - ROUND TWO pairs, resolved for each production venue')
    for (const [key, where] of PAIRS) {
      const counter = COPY['payCounter' + key]
      const table = COPY['payTable' + key]
      check(Boolean(counter) && Boolean(table), key + ': both halves exist', where)
      if (!counter || !table) continue
      // Equality here would make is_counter_service decorative for this pair.
      check(counter !== table, key + ': the two service models say DIFFERENT things')
      check(!PROMISES_A_PERSON.test(counter), key + ': the COUNTER half promises no person', '"' + counter + '"')
    }

    console.log('\n  CONTROL - the TABLE halves are where a person is still promised.')
    const promising = PAIRS.filter(([k]) => PROMISES_A_PERSON.test(COPY['payTable' + k] || ''))
    check(
      promising.length > 0,
      'at least one TABLE half still promises a person',
      promising.length + ' of ' + PAIRS.length + ' do - so the negative above is not vacuous',
    )

    console.log('\n  WHAT THE TWO LIVE COUNTER VENUES ACTUALLY READ:')
    for (const r of rows.filter((x) => x.is_counter_service === true)) {
      console.log('    ' + String(r.name) + ':')
      for (const [key] of PAIRS) console.log('      ' + key.padEnd(24) + ' "' + COPY['payCounter' + key] + '"')
    }

    console.log(bad === 0 ? '\nEFFECT_PROOFS_COPY_OK' : `\n*** ${bad} CHECK(S) FAILED ***`)
    if (bad > 0) process.exitCode = 1
  } finally {
    await db.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
