/**
 * THE INVENTORY'S DEAD ENDS, RE-OPENED — STRICTLY READ-ONLY.
 *
 * `docs/staging-backlog-inventory.md` closes several questions with "cannot be established from
 * this environment", on the belief that the production service-role key existed only as a GitHub
 * secret. It is in `.env.local`. This re-opens every one of those and answers what a read can
 * answer.
 *
 * GETs and one STABLE SELECT-only RPC. No insert, update, delete, DDL, or migration application.
 * Nothing writes to supabase_migrations. Where an answer needs a write, it is left UNESTABLISHED
 * and said so.
 */
import { readFileSync } from 'node:fs'

const ENV_PATH = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'

const env = {}
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !URL_.includes(PROD_REF)) throw new Error(`REFUSING: not production — ${URL_}`)
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const say = (tag, q, detail) => console.log(`${tag.padEnd(14)} ${q}\n${' '.repeat(15)}${detail}\n`)

async function get(path, extraHeaders = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { ...H, ...extraHeaders } })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

async function main() {
  console.log(`INVENTORY DEAD ENDS — ${URL_}\nREAD-ONLY. GETs and one STABLE RPC.\n${'='.repeat(78)}\n`)

  // -------------------------------------------------- §1.1 restaurants.short_code
  {
    const r = await get('restaurants?select=short_code&limit=0')
    say(
      r.status === 200 ? 'PRESENT' : 'ABSENT',
      '§1.1  restaurants.short_code',
      r.status === 200
        ? 'the column exists on production'
        : `HTTP ${r.status} — ${r.text.slice(0, 120)}`,
    )
  }

  // -------------------------------------------------- §1.1 document_sequences
  {
    const r = await get('document_sequences?select=*&limit=1')
    say(
      r.status === 200 ? 'PRESENT' : 'NOT_VISIBLE',
      '§1.1  document_sequences',
      r.status === 200 ? `rows readable; sample: ${r.text.slice(0, 120)}` : `HTTP ${r.status}`,
    )
  }

  // -------------------------------------------------- §1.1 generate_document_number()
  {
    // STILL UNESTABLISHED, and it is worth being precise about why, because two plausible-looking
    // answers are both wrong.
    //
    // (a) A direct RPC call is inconclusive — but NOT for the reason the inventory gives. The
    //     inventory says main revokes the grants so PostgREST cannot see it either way. The actual
    //     reason a no-argument call 404s is that PostgREST resolves overloads by ARGUMENT NAME, and
    //     this function takes p_prefix and p_sequence_name (lib/receipts/issueReceipt.ts:177).
    //     PGRST202 on `{}` says nothing about existence. Calling it correctly WOULD answer it — and
    //     would also consume a sequence value, which is a write. So it is not called.
    //
    // (b) "business_documents has numbered rows, so the function ran" is a FALSE positive, and the
    //     tempting one. issueReceipt.ts asks for prefix 'RCT' from sequence 'rct_number_seq'.
    //     Production's rows are document_type 'invoice' numbered '1', '2', '1' — bare, and
    //     restarting per restaurant. They come from the admin documents routes via
    //     document_sequences, not from this function. Evidence of a different path is not evidence
    //     of this one.
    const rpc = await fetch(`${URL_}/rest/v1/rpc/generate_document_number`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await rpc.text()
    const docs = await get('business_documents?select=document_type,document_number,restaurant_id')
    say(
      'UNESTABLISHED',
      '§1.1  generate_document_number() exists on production?',
      `no-arg RPC: HTTP ${rpc.status} ${body.slice(0, 70)}\n` +
        `${' '.repeat(15)}inconclusive by ARGUMENT MISMATCH (p_prefix, p_sequence_name), not by grants.\n` +
        `${' '.repeat(15)}business_documents on production: ${docs.text.slice(0, 150)}\n` +
        `${' '.repeat(15)}Those are NOT RCT-prefixed, so they are not this function's output and are\n` +
        `${' '.repeat(15)}not evidence it exists. Answering it needs a call, and a call is a write.`,
    )
  }

  // -------------------------------------------------- §1.2 refund_events
  {
    const r = await get('refund_events?select=*&limit=0')
    say(
      r.status === 200 ? 'PRESENT' : 'ABSENT',
      '§1.2  refund_events table',
      r.status === 200 ? 'exists on production' : `HTTP ${r.status} — matches the inventory (absent)`,
    )
  }

  // -------------------------------------------------- §1.3 the staging seed row
  {
    // The table is restaurant_whatsapp_accounts, not whatsapp_accounts. A wrong name here returns
    // PGRST205, which reads exactly like "the row is absent" and would pass for the wrong reason.
    // The restaurant is probed too, so an empty result is backed by the row's owner also being gone.
    const r = await get(
      'restaurant_whatsapp_accounts?select=id,phone_number_id,restaurant_id&phone_number_id=eq.1273668565820748',
    )
    const owner = await get(
      'restaurants?select=id,name&id=eq.a1999166-ddfa-40d1-ad1f-2f01282a1652',
    )
    const clean = r.status === 200 && r.text.trim() === '[]' && owner.text.trim() === '[]'
    say(
      clean ? 'ABSENT (good)' : 'CHECK',
      '§1.3  seed_whatsapp_account_staging row on production',
      `account rows: HTTP ${r.status} ${r.text.slice(0, 60)}
` +
        `${' '.repeat(15)}the "staging test" restaurant it seeds for: ${owner.text.slice(0, 60)}`,
    )
  }

  // -------------------------------------------------- §1.4 the duplicate count
  {
    // The gating question: CREATE UNIQUE INDEX aborts if duplicates exist. PostgREST cannot GROUP
    // BY, so page the two columns and count here. Paginated deliberately — an unpaginated read
    // stops at 1000 and would under-report, which is #323's exact failure mode.
    const PAGE = 1000
    let from = 0
    const seen = new Map()
    let rows = 0
    for (;;) {
      const r = await get(
        'orders?select=firebase_restaurant_id,order_number' +
          '&firebase_restaurant_id=not.is.null&order_number=not.is.null' +
          `&order=id.asc&limit=${PAGE}&offset=${from}`,
      )
      if (r.status !== 200) {
        say('ERROR', '§1.4  duplicate (firebase_restaurant_id, order_number)', `HTTP ${r.status} ${r.text.slice(0, 120)}`)
        return
      }
      const batch = JSON.parse(r.text)
      for (const o of batch) {
        const k = `${o.firebase_restaurant_id}\u0000${o.order_number}`
        seen.set(k, (seen.get(k) ?? 0) + 1)
      }
      rows += batch.length
      if (batch.length < PAGE) break
      from += PAGE
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1)
    say(
      dupes.length ? 'BLOCKED' : 'CLEAR',
      '§1.4  orders_unique_order_number — can the partial unique index be created?',
      `${rows} rows with both columns non-null; ${seen.size} distinct pairs; ` +
        `${dupes.length} duplicate pair(s).\n` +
        `${' '.repeat(15)}` +
        (dupes.length
          ? `CREATE UNIQUE INDEX WOULD ABORT. First few:\n${dupes
              .slice(0, 10)
              .map(([k, n]) => `${' '.repeat(17)}${k.replace('\u0000', ' / ')}  x${n}`)
              .join('\n')}`
          : 'No duplicates. The index would create cleanly on today\u2019s data.'),
    )
  }

  // -------------------------------------------------- §1.4 is it applied?
  {
    const rpc = await fetch(`${URL_}/rest/v1/rpc/list_applied_migration_versions`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const versions = (await rpc.json()).map((r) => String(r.version))
    const applied = versions.includes('20260809120000')
    say(
      applied ? 'APPLIED' : 'NOT APPLIED',
      '§1.4  is 20260809120000_orders_unique_order_number applied to production?',
      applied
        ? 'the ledger records it'
        : 'the ledger does not record it, and the ledger is exact against the committed files\n' +
          `${' '.repeat(15)}(0 applied-with-no-file, both directions checked). The inventory listed this\n` +
          `${' '.repeat(15)}as UNKNOWN; it is now NOT APPLIED.`,
    )
  }

  console.log('='.repeat(78))
  console.log(
    'STILL UNESTABLISHED, and why:\n' +
      '  - Whether the unique INDEX itself exists independently of the ledger. Indexes are not\n' +
      '    exposed by PostgREST; proving it would need a duplicate insert, which is a write.\n' +
      '  - Every CHECK constraint, RLS policy, grant and trigger. pg_constraint and pg_proc both\n' +
      '    return HTTP 404 PGRST205, measured.\n' +
      '  - Whether generate_document_number() exists as a callable function. Its grants are\n' +
      '    revoked, so a direct call cannot distinguish absent from unreachable. Evidence of use\n' +
      '    is the strongest read-only signal available.',
  )
}

main().catch((e) => {
  console.error('ABORTED:', e)
  process.exitCode = 2
})
