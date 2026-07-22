/**
 * Read-only: fetch the actual Auth config (site_url, uri_allow_list, and the
 * two "Secure ___" toggles) for both staging and production directly from
 * the Supabase Management API, rather than inferring them indirectly.
 *
 * Uses the same access-token mechanism as supabase/.temp/query-audit-mgmt.mjs
 * (reads the Supabase CLI's own login profile — never prints the token).
 *
 *   node scripts/investigate-auth-config-redirect-allowlist.mjs
 */
import fs from 'fs'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

let token = ''
try {
  const profilePath = `${process.env.USERPROFILE || process.env.HOME}/.supabase/profile`
  if (fs.existsSync(profilePath)) {
    const profile = fs.readFileSync(profilePath, 'utf8')
    const m = profile.match(/access_token\s*=\s*"?([^"\n]+)"?/)
    if (m) token = m[1].trim()
  }
} catch {}

if (!token) {
  console.log('NO_MGMT_TOKEN: could not find a Supabase CLI access token at ~/.supabase/profile')
  process.exit(1)
}

async function fetchAuthConfig(ref, label) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  console.log(`\n=== ${label} (${ref}) ===`)
  if (!res.ok) {
    console.log('ERROR', res.status, body?.message ?? body)
    return
  }
  console.log('site_url:                 ', body.site_url)
  console.log('uri_allow_list:           ', body.uri_allow_list)
  console.log('mailer_secure_email_change_enabled:', body.mailer_secure_email_change_enabled)
  console.log('security_update_password_require_reauthentication:', body.security_update_password_require_reauthentication)
  console.log('mailer_otp_exp (seconds): ', body.mailer_otp_exp)
  console.log('disable_signup:           ', body.disable_signup)
  console.log('external_email_enabled:   ', body.external_email_enabled)
}

await fetchAuthConfig(STAGING_REF, 'STAGING')
await fetchAuthConfig(PRODUCTION_REF, 'PRODUCTION')
