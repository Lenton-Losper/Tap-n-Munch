/**
 * Local, no network: verifies the ACTUAL app/auth/callback/route.ts GET
 * handler correctly detects the message-only intermediate state (type=
 * email_change with no code) instead of falling through to the generic
 * OAuth error redirect. Safe to run directly (no Next.js request context
 * needed) because this branch returns before ever calling cookies()/
 * createServerClient().
 *
 *   npx tsx scripts/verify-callback-email-change-pending-local.ts
 */
import { GET } from '../app/auth/callback/route'

async function check(label: string, url: string, expectedLocation: string) {
  const response = await GET(new Request(url))
  const location = response.headers.get('location')
  const pass = location === expectedLocation
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}`)
  console.log(`  url:      ${url}`)
  console.log(`  expected: ${expectedLocation}`)
  console.log(`  actual:   ${location}`)
  if (!pass) process.exitCode = 1
}

async function main() {
  await check(
    'first-of-two confirmation (no code, no error)',
    'https://example.com/auth/callback?type=email_change',
    'https://example.com/settings?email_change_pending=1#profile',
  )

  await check(
    'first-of-two confirmation with an error param',
    'https://example.com/auth/callback?type=email_change&error=access_denied&error_description=Link+expired',
    'https://example.com/settings?error=email_change_link#profile',
  )

  await check(
    'no code, no type at all -- falls through to generic oauth error (unchanged existing behavior)',
    'https://example.com/auth/callback',
    'https://example.com/signin?error=oauth',
  )

  if (process.exitCode === 1) {
    console.log('\n=== SOME CHECKS FAILED ===')
  } else {
    console.log('\n=== ALL CHECKS PASSED ===')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
