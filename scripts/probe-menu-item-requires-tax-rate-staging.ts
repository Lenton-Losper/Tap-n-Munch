/**
 * A MENU ITEM CANNOT BE SAVED WITHOUT AN EXPLICITLY CHOSEN TAX RATE — against the DEPLOYED worker.
 *
 * The unit tests prove the rule; they cannot prove the ROUTE applies it. This does, over real HTTP
 * with a real staff bearer token, because /api/admin/menu/items is reachable without the form and
 * the form check is only convenience.
 *
 * TWO-SIDED, and the ACCEPTED cases are what make the REFUSED ones mean anything — a route that
 * refused every write would pass a one-sided version of this probe:
 *
 *   CREATE with no rate         must be REFUSED    <- the defect, stated as a rule
 *   CREATE with a rate          must SUCCEED       <- the control
 *   CREATE with a 0% rate       must SUCCEED       <- zero-rating stays reachable, deliberately
 *   CREATE a foreign rate       must be REFUSED    <- a rate this tenant does not own
 *   EDIT price only             must SUCCEED       <- omitting the field is not clearing it
 *   EDIT clearing the rate      must be REFUSED    <- and must not reach the database
 *   EDIT a legacy null item     must be REFUSED    <- what finally puts the question on the 390
 *   EDIT it choosing a rate     must SUCCEED       <- and the refusal is escapable
 *
 * The legacy row is seeded by writing DIRECTLY, because the route now refuses to create one. That
 * is the point of it.
 *
 * Staging only, self-cleaning: every fixture is removed in a finally block.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_SIM_BASE || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
// .env.test names it SUPABASE_ANON_KEY; the app names it NEXT_PUBLIC_. Accept either.
const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
if (!anon) throw new Error('GUARD: no anon key — the staff token cannot be minted')
if (!url.includes(STAGING_REF)) {
  throw new Error(`GUARD: ${url || '(unset)'} is not the staging project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

let token = ''
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

const results: Array<{ name: string; want: string; got: string; ok: boolean; detail: string }> = []

function record(name: string, wantRefused: boolean, status: number, body: any) {
  const refused = status >= 400
  const ok = refused === wantRefused
  const msg = body?.error || body?.message || (Array.isArray(body?.errors) ? body.errors.join('; ') : '')
  results.push({
    name,
    want: wantRefused ? 'REFUSED' : 'ACCEPTED',
    got: refused ? `REFUSED ${status}` : `ACCEPTED ${status}`,
    ok,
    detail: String(msg || '').slice(0, 130),
  })
}

async function main() {
  const version = await api('/api/version')
  console.log(`\nWORKER ${BASE}`)
  console.log(`SHA    ${version.body?.commit ?? '?'}\n`)

  const email = `probe-tax-${randomUUID().slice(0, 8)}@flashtap-test.invalid`
  const password = `Pv-${randomUUID()}`
  const created: string[] = []
  let staffId = ''
  let catId = ''
  let legacyId = ''
  let foreignRestaurantId = ''
  let seededZeroRateId = ''

  try {
    // ---- a staff account holding MENU_WRITE on the fixture restaurant
    const { data: u, error: uErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (uErr) throw new Error(`create staff: ${uErr.message}`)
    staffId = u.user.id
    await admin.from('users').insert({ id: staffId, email, full_name: 'probe tax', avatar_url: null })
    const { error: mErr } = await admin
      .from('restaurant_users')
      .insert({ restaurant_id: RID, user_id: staffId, role: 'owner' })
    if (mErr) throw new Error(`membership: ${mErr.message}`)

    const authClient = createClient(url, anon, { auth: { persistSession: false } })
    const { data: sess, error: sErr } = await authClient.auth.signInWithPassword({ email, password })
    if (sErr || !sess?.session) throw new Error(`sign in: ${sErr?.message}`)
    token = sess.session.access_token

    /**
     * There is no GET on this route — only POST/PATCH/DELETE — so the control cannot be a read.
     * It is the first successful CREATE below instead, and it is FATAL: without it, every REFUSED
     * result is indistinguishable from a dead or unauthenticated endpoint. That is the exact
     * failure that let a security chain read green during a total customer lockout.
     */
    const { data: cat, error: cErr } = await admin
      .from('menu_categories')
      .insert({ restaurant_id: RID, name: `probe-tax-cat-${randomUUID().slice(0, 6)}`, display_order: 999 })
      .select('id')
      .single()
    if (cErr) throw new Error(`seed category: ${cErr.message}`)
    catId = cat.id

    const { data: rates, error: rErr } = await admin
      .from('tax_rates')
      .select('id, name, percentage, is_default')
      .eq('restaurant_id', RID)
    if (rErr) throw new Error(`read rates: ${rErr.message}`)
    console.log(`  [control] rates on the fixture    : ${(rates ?? []).length}`)
    for (const r of rates ?? []) {
      console.log(`              ${String(r.name).padEnd(20)} ${r.percentage}%  default=${r.is_default}`)
    }
    if (!rates?.length) throw new Error('control failed: the fixture restaurant has no tax rates')
    const anyRate = rates[0]

    /**
     * The fixture has only Standard 15%, so the deliberately-zero-rated case would not run and
     * would report itself as a coverage gap. It is the case that guarantees the ruling removed the
     * IMPLICIT fallback and not the ability to zero-rate, so it is worth seeding one for.
     * is_default is left false — the fixture's default is not being changed.
     */
    let zeroRate = rates.find((r) => Number(r.percentage) === 0) ?? null
    if (!zeroRate) {
      const { data: seeded, error: zErr } = await admin
        .from('tax_rates')
        .insert({
          restaurant_id: RID,
          name: `probe-zero-${randomUUID().slice(0, 6)}`,
          percentage: 0,
          is_inclusive: true,
          is_default: false,
        })
        .select('id, name, percentage')
        .single()
      if (zErr) console.log(`  [note] could not seed a 0% rate: ${zErr.message}`)
      else {
        zeroRate = seeded
        seededZeroRateId = seeded.id
        console.log(`  [seeded] a 0% rate for the zero-rating case: ${seeded.name}`)
      }
    }

    // A rate belonging to SOMEONE ELSE.
    const { data: other } = await admin
      .from('tax_rates')
      .select('id, restaurant_id')
      .neq('restaurant_id', RID)
      .limit(1)
      .maybeSingle()
    foreignRestaurantId = other?.restaurant_id ?? ''

    const draft = (extra: Record<string, unknown>) => ({
      restaurant_id: RID,
      name: `probe-tax-${randomUUID().slice(0, 6)}`,
      base_price: 25,
      category_id: catId,
      status: 'available',
      ...extra,
    })
    const idOf = (body: any) => body?.item?.id ?? body?.id ?? body?.data?.id ?? null

    // ============================== CREATE ==============================
    /**
     * THE CONTROL, run first and fatal. A properly chosen rate must still save; if it does not,
     * the refusals below prove nothing about the rule and everything about a broken endpoint.
     */
    const withRate = await api('/api/admin/menu/items', {
      method: 'POST',
      body: JSON.stringify(draft({ tax_rate_id: anyRate.id })),
    })
    record(`CREATE with a chosen rate (${anyRate.name})`, false, withRate.status, withRate.body)
    const goodId = idOf(withRate.body)
    if (goodId) created.push(goodId)
    console.log(
      `  [control] CREATE with a valid rate: ${withRate.status}` +
        (withRate.status < 400 ? '  OK' : '  <- THIS INVALIDATES EVERY REFUSAL BELOW'),
    )
    if (withRate.status >= 400) {
      throw new Error(
        `control failed: a valid create was refused (${withRate.status} ${JSON.stringify(withRate.body).slice(0, 200)})`,
      )
    }

    const noRate = await api('/api/admin/menu/items', {
      method: 'POST',
      body: JSON.stringify(draft({})),
    })
    record('CREATE with no tax rate at all', true, noRate.status, noRate.body)
    if (idOf(noRate.body)) created.push(idOf(noRate.body))

    const blank = await api('/api/admin/menu/items', {
      method: 'POST',
      body: JSON.stringify(draft({ tax_rate_id: '' })),
    })
    record('CREATE with tax_rate_id = ""', true, blank.status, blank.body)
    if (idOf(blank.body)) created.push(idOf(blank.body))

    if (zeroRate) {
      const withZero = await api('/api/admin/menu/items', {
        method: 'POST',
        body: JSON.stringify(draft({ tax_rate_id: zeroRate.id })),
      })
      record(`CREATE deliberately zero-rated (${zeroRate.name})`, false, withZero.status, withZero.body)
      if (idOf(withZero.body)) created.push(idOf(withZero.body))
    } else {
      results.push({
        name: 'CREATE deliberately zero-rated',
        want: 'ACCEPTED',
        got: 'NOT RUN — the fixture has no 0% rate',
        ok: true,
        detail: 'coverage gap, stated rather than hidden',
      })
    }

    if (other?.id) {
      const foreign = await api('/api/admin/menu/items', {
        method: 'POST',
        body: JSON.stringify(draft({ tax_rate_id: other.id })),
      })
      record('CREATE with another restaurant rate id', true, foreign.status, foreign.body)
      if (idOf(foreign.body)) created.push(idOf(foreign.body))
    } else {
      results.push({
        name: 'CREATE with another restaurant rate id',
        want: 'REFUSED',
        got: 'NOT RUN — no foreign rate exists on staging',
        ok: true,
        detail: 'coverage gap, stated rather than hidden',
      })
    }

    // =============================== EDIT ===============================
    if (goodId) {
      const priceOnly = await api('/api/admin/menu/items', {
        method: 'PATCH',
        body: JSON.stringify({ restaurant_id: RID, id: goodId, base_price: 31 }),
      })
      record('EDIT price only, tax_rate_id absent', false, priceOnly.status, priceOnly.body)

      const cleared = await api('/api/admin/menu/items', {
        method: 'PATCH',
        body: JSON.stringify({ restaurant_id: RID, id: goodId, tax_rate_id: '' }),
      })
      record('EDIT clearing the rate', true, cleared.status, cleared.body)

      // A 4xx is not proof nothing was written. Read the row back.
      const after = (await admin.from('menu_items').select('tax_rate_id').eq('id', goodId).single()).data
      results.push({
        name: 'the refused clear never reached the database',
        want: 'rate intact',
        got: after?.tax_rate_id ? 'rate intact' : 'CLEARED ANYWAY',
        ok: !!after?.tax_rate_id,
        detail: String(after?.tax_rate_id ?? 'null'),
      })
    }

    // A LEGACY ROW — written directly, since the route now refuses to make one.
    const { data: legacy, error: lErr } = await admin
      .from('menu_items')
      .insert({
        restaurant_id: RID,
        name: `probe-tax-legacy-${randomUUID().slice(0, 6)}`,
        base_price: 40,
        status: 'available',
        tax_rate_id: null,
        category_id: catId,
        track_inventory: false,
      })
      .select('id, tax_rate_id')
      .single()
    if (lErr) throw new Error(`seed legacy row: ${lErr.message}`)
    legacyId = legacy.id
    console.log(
      `  [control] legacy row tax_rate_id  : ${legacy.tax_rate_id === null ? 'null — as intended' : 'NOT NULL, that case is void'}`,
    )

    const legacyEdit = await api('/api/admin/menu/items', {
      method: 'PATCH',
      body: JSON.stringify({ restaurant_id: RID, id: legacyId, base_price: 41 }),
    })
    record('EDIT a legacy null-rate item, price only', true, legacyEdit.status, legacyEdit.body)

    const legacyFixed = await api('/api/admin/menu/items', {
      method: 'PATCH',
      body: JSON.stringify({ restaurant_id: RID, id: legacyId, base_price: 41, tax_rate_id: anyRate.id }),
    })
    record('EDIT that legacy item, now choosing a rate', false, legacyFixed.status, legacyFixed.body)

    // ============================== VERDICT ==============================
    console.log(`\n${'='.repeat(96)}`)
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(44)} want=${r.want.padEnd(11)} got=${r.got}`)
      if (r.detail) console.log(`          ${r.detail}`)
    }
    const failed = results.filter((r) => !r.ok)
    console.log(
      `\n  ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length} cases against ${version.body?.commit ?? '?'}`,
    )
    if (foreignRestaurantId) console.log(`  (foreign rate borrowed from restaurant ${foreignRestaurantId})`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    for (const id of created) if (id) await admin.from('menu_items').delete().eq('id', id)
    if (seededZeroRateId) await admin.from('tax_rates').delete().eq('id', seededZeroRateId)
    if (legacyId) await admin.from('menu_items').delete().eq('id', legacyId)
    if (catId) {
      await admin.from('menu_items').delete().eq('category_id', catId)
      await admin.from('menu_categories').delete().eq('id', catId)
    }
    if (staffId) {
      await admin.from('restaurant_users').delete().eq('user_id', staffId)
      await admin.from('users').delete().eq('id', staffId)
      await admin.auth.admin.deleteUser(staffId)
    }
    console.log('  cleaned')
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
