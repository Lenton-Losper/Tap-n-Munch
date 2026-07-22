import { createClient } from '@supabase/supabase-js'
import { PDFDocument } from 'pdf-lib'
import fs from 'fs'

const PROD_BASE = 'https://www.flashtap.app'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'

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

async function getToken(admin: ReturnType<typeof createClient>, email: string) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr) throw linkErr
  const { data: sess, error: otpErr } = await admin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'email',
  })
  if (otpErr) {
    const retry = await admin.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: 'magiclink',
    })
    if (retry.error) throw retry.error
    return retry.data.session!.access_token
  }
  return sess!.session!.access_token
}

async function main() {
  const prod = loadEnv('.env.production.local')
  const admin = createClient(prod.NEXT_PUBLIC_SUPABASE_URL, prod.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const expectedSha = process.argv[2] ?? 'dd7a9d1'
  const emailTo = process.argv[3] ?? 'delivered@resend.dev'
  const today = new Date().toISOString().slice(0, 10)

  const versionRes = await fetch(`${PROD_BASE}/api/version`)
  const version = await versionRes.json()

  const { data: schedules } = await admin
    .from('report_schedules')
    .select('id,email,format,enabled,send_time,last_sent_at')
    .eq('restaurant_id', RIVIERA_ID)
    .order('created_at', { ascending: true })

  const token = await getToken(admin, 'flashtap.staging.test@gmail.com')
  const emailResults: Record<string, unknown> = {}
  for (const format of ['csv', 'pdf'] as const) {
    const res = await fetch(`${PROD_BASE}/api/admin/restaurants/${RIVIERA_ID}/reports/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: emailTo,
        format,
        startDate: '2026-07-01',
        endDate: today,
      }),
    })
    emailResults[format] = {
      status: res.status,
      body: await res.json().catch(() => ({})),
    }
  }

  console.log(
    JSON.stringify(
      {
        expectedSha,
        version,
        versionMatches: String(version.commit ?? '').startsWith(expectedSha),
        rivieraSchedules: schedules ?? [],
        emailResults,
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
