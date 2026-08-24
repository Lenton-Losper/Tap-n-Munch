/**
 * is_counter_service — the data half, for FNB ChowNow and Chownow Nedbank. Production. WRITES.
 *
 * The migration that adds the column carries this same UPDATE, matched on name. This script exists
 * because a migration applied out of order, or applied before those venues were named, leaves the
 * column at its default `false` — and `false` means "staff come to your table", which is the
 * assertion that was wrong in the first place.
 *
 * IT MATCHES ON NAME, EXACTLY, AND REFUSES ON ANYTHING SURPRISING:
 *   - a name matching zero rows        -> refuse. The venue is named differently and a human decides.
 *   - a name matching MORE than one    -> refuse. Two venues share a name; flipping both is a guess.
 *   - the column not existing          -> refuse. The migration has not been applied yet.
 *
 * It is idempotent: a venue already true is reported and left alone.
 *
 * WHY NOT MATCH ON ID: I do not have the production ids, and inventing a lookup by something I
 * cannot verify would be worse than matching the string the owner used. The refusals above are what
 * make the name match safe.
 */
import { guard } from './_guard'

const COUNTER_SERVICE_VENUES = ['FNB ChowNow', 'Chownow Nedbank']

async function main() {
  const { db, confirmed } = guard(
    [
      'Sets restaurants.is_counter_service = true for exactly these venues:',
      ...COUNTER_SERVICE_VENUES.map((n) => `    "${n}"`),
      '',
      'Refuses if a name matches zero rows or more than one. Idempotent.',
      'Affects customer-facing payment copy: counter copy stops promising a person',
      'who is not coming.',
    ],
    true,
  )

  // Does the column exist? If the migration has not been applied, say so rather than failing oddly.
  const { error: colErr } = await db.from('restaurants').select('id, is_counter_service').limit(1)
  if (colErr) {
    console.error('REFUSING: cannot read restaurants.is_counter_service —', colErr.message)
    console.error('  The migration 20260824120000_restaurants_is_counter_service.sql is probably not applied.')
    process.exit(2)
  }

  const failures: string[] = []
  const targets: { id: string; name: string; current: boolean }[] = []

  for (const name of COUNTER_SERVICE_VENUES) {
    const { data, error } = await db
      .from('restaurants')
      .select('id, name, is_counter_service')
      .eq('name', name)
    if (error) {
      failures.push(`${name}: query failed — ${error.message}`)
      continue
    }
    const rows = (data ?? []) as { id: string; name: string; is_counter_service: boolean | null }[]
    console.log(`  "${name}" -> ${rows.length} row(s)`)
    if (rows.length === 0) {
      failures.push(`"${name}" matched NO restaurant — the venue is named differently on production`)
      continue
    }
    if (rows.length > 1) {
      failures.push(`"${name}" matched ${rows.length} restaurants — flipping all of them would be a guess`)
      continue
    }
    const row = rows[0]
    console.log(`      id ${row.id}   is_counter_service currently ${row.is_counter_service}`)
    targets.push({ id: String(row.id), name: String(row.name), current: row.is_counter_service === true })
  }

  if (failures.length > 0) {
    console.log('')
    console.log('='.repeat(78))
    console.log('REFUSING TO WRITE:')
    console.log('='.repeat(78))
    for (const f of failures) console.log('  - ' + f)
    console.log('')
    console.log('Nothing was changed. Confirm the exact production venue names and re-run.')
    process.exit(2)
  }

  const toChange = targets.filter((t) => !t.current)
  console.log('')
  console.log(`already true: ${targets.length - toChange.length}   to change: ${toChange.length}`)

  if (toChange.length === 0) {
    console.log('Nothing to do — both venues are already counter service.')
    return
  }
  if (!confirmed) {
    console.log('')
    console.log('DRY RUN. Would set is_counter_service = true for:')
    for (const t of toChange) console.log(`  ${t.name}  (${t.id})`)
    console.log('Re-run with --confirm to apply.')
    return
  }

  for (const t of toChange) {
    const { data, error } = await db
      .from('restaurants')
      .update({ is_counter_service: true } as never)
      .eq('id', t.id)
      .select('id, name, is_counter_service')
    if (error) throw new Error(`${t.name}: ${error.message}`)
    const row = (data ?? [])[0] as { name: string; is_counter_service: boolean } | undefined
    console.log(`  set ${row?.name} -> is_counter_service = ${row?.is_counter_service}`)
  }

  // Prove the effect, and prove nothing ELSE moved.
  const { data: allCounter } = await db
    .from('restaurants')
    .select('id, name')
    .eq('is_counter_service', true)
  console.log('')
  console.log(`counter-service venues on production now: ${(allCounter ?? []).length}`)
  for (const r of (allCounter ?? []) as { name: string }[]) console.log(`  ${r.name}`)
  console.log('')
  console.log('  If any venue above is NOT one of the two named, something else set it and that is')
  console.log('  worth understanding before the copy ships.')
  console.log('')
  console.log('APPLY_IS_COUNTER_SERVICE_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
