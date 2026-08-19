/**
 * WHAT IS THE "dsgdsg" TEST DEBRIS LINKED TO? Production, strictly READ-ONLY.
 *
 * Asked for before any deletion, and separately from the organisation merge. Two rows are in
 * question and they are NOT the same object:
 *
 *   organization_stock_items  8128e143-0f66-47da-9ddc-4fed0aaf3994   the org-level catalogue entry
 *   stock_items               b77e6ec7-8a55-46e4-9eab-3f4d5eb235c2   Riviera's local item, pointing at it
 *
 * EVERY FOREIGN KEY INTO stock_items IS `ON DELETE RESTRICT` -- stock_movements, goods_received_items
 * and recipe_items all are. So a delete cannot cascade and cannot quietly destroy history: it either
 * succeeds because nothing references the row, or it fails loudly. That makes the database the
 * backstop, but it does not make the count unnecessary -- "it will fail" and "it will succeed" are
 * different plans, and a movement row means the item was actually USED, which is evidence it may
 * not be debris at all.
 *
 * Every read is error-checked and a failure VOIDS its line rather than printing zero. "Nothing
 * references it" and "the query broke" must not look the same -- a confident absence built on a
 * failed read is a mistake already made once in this session.
 *
 * SELECTS ONLY. Deletes nothing.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

const ORG_ITEM = '8128e143-0f66-47da-9ddc-4fed0aaf3994'
const STOCK_ITEM = 'b77e6ec7-8a55-46e4-9eab-3f4d5eb235c2'

let voided = false

async function refs(label, table, column, value) {
  const { data, error } = await admin.from(table).select('*').eq(column, value).limit(5)
  if (error) {
    voided = true
    console.log(`      ${label.padEnd(46)} READ FAILED — ${error.message}`)
    return -1
  }
  const { count, error: cErr } = await admin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
  if (cErr) {
    voided = true
    console.log(`      ${label.padEnd(46)} COUNT FAILED — ${cErr.message}`)
    return -1
  }
  console.log(`      ${label.padEnd(46)} ${count} row(s)`)
  for (const r of data ?? []) console.log(`          ${JSON.stringify(r).slice(0, 190)}`)
  return count ?? 0
}

async function main() {
  console.log('\nPRODUCTION — what is "dsgdsg" linked to? Read-only, deletes nothing.')
  console.log(`  project ref confirmed in URL: ${PRODUCTION_REF}\n`)

  const { data: ctl, error: ctlErr } = await admin.from('stock_items').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] stock_items readable: ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  // ---- the two rows themselves
  const { data: osi, error: osiErr } = await admin
    .from('organization_stock_items').select('*').eq('id', ORG_ITEM).maybeSingle()
  if (osiErr) { voided = true; console.log(`  catalogue row READ FAILED: ${osiErr.message}`) }
  console.log(`\n  CATALOGUE ROW   ${osi ? JSON.stringify(osi) : '(absent)'}`)

  const { data: si, error: siErr } = await admin
    .from('stock_items').select('*').eq('id', STOCK_ITEM).maybeSingle()
  if (siErr) { voided = true; console.log(`  stock_items row READ FAILED: ${siErr.message}`) }
  console.log(`  STOCK ITEM ROW  ${si ? JSON.stringify(si).slice(0, 400) : '(absent)'}`)

  // ---- everything that could hold it. All ON DELETE RESTRICT.
  console.log('\n  REFERENCES TO THE stock_items ROW (all FKs here are ON DELETE RESTRICT):')
  const movements = await refs('stock_movements.stock_item_id', 'stock_movements', 'stock_item_id', STOCK_ITEM)
  const grv = await refs('goods_received_items.stock_item_id', 'goods_received_items', 'stock_item_id', STOCK_ITEM)
  const recipeItems = await refs('recipe_items.stock_item_id', 'recipe_items', 'stock_item_id', STOCK_ITEM)

  console.log('\n  REFERENCES TO THE CATALOGUE ROW:')
  const otherLocals = await refs('stock_items.organization_stock_item_id', 'stock_items', 'organization_stock_item_id', ORG_ITEM)
  const transferItems = await refs('stock_transfer_items.organization_stock_item_id', 'stock_transfer_items', 'organization_stock_item_id', ORG_ITEM)

  // ---- the verdict
  console.log('\n  ================ VERDICT')
  if (voided) {
    console.error('  VOID — a read failed above. "Nothing references it" cannot be distinguished from')
    console.error('  "nothing was successfully searched". Fix the query and re-run before deleting.')
    process.exit(1)
  }

  const blockers = [
    ['stock_movements', movements],
    ['goods_received_items', grv],
    ['recipe_items', recipeItems],
    ['stock_transfer_items', transferItems],
  ].filter(([, n]) => n > 0)

  console.log(`  local stock_items pointing at the catalogue row: ${otherLocals}`)
  if (otherLocals > 1) {
    console.log('  *** MORE THAN ONE. Another restaurant also uses this catalogue entry, so it is not')
    console.log('      debris belonging to one site. Deleting the catalogue row would break the other.')
  }

  if (!blockers.length) {
    console.log('  NOTHING references the stock_items row, and nothing outside it references the')
    console.log('  catalogue row. A delete would succeed: stock_items first, then the catalogue row.')
    console.log('  The item was never used -- no movements, no receipts, no recipe membership --')
    console.log('  which is consistent with it being test debris.')
  } else {
    console.log('  *** IT HAS BEEN USED. References found in: ' + blockers.map(([t, n]) => `${t}=${n}`).join(', '))
    console.log('  ON DELETE RESTRICT means the delete would FAIL rather than destroy this history.')
    console.log('  Deleting it would require removing that history first, which is a different and')
    console.log('  much larger decision than clearing a stray row. STOP and rule again.')
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
