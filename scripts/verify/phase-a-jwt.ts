/**
 * PHASE A VERIFICATION — run with tsx, not jest.
 *
 * `jose` is ESM-only and breaks terminal-auth under ts-jest ("Jest encountered an unexpected
 * token"), which is a recorded property of this repo, not a new discovery. The established way to
 * exercise this module is an in-process tsx script, so that is what this is.
 *
 *   npx tsx scripts/verify/phase-a-jwt.ts
 *
 * Exit 0 = every assertion held. Exit 1 = at least one did not, and it says which.
 */
import { SignJWT, decodeProtectedHeader, decodeJwt, importPKCS8 } from 'jose'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { TERMINAL_SIGNING_KEYS, ACTIVE_KID, jwksDocument, findSigningKey } from '../../lib/terminals/signing-keys'

const HS_SECRET = 'verify-secret'
const P = {
  terminal_id: '11111111-1111-4111-8111-111111111111',
  restaurant_id: '22222222-2222-4222-8222-222222222222',
  device_serial: 'ft-verify',
}

const failures: string[] = []
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures.push(name)
}

async function main() {
  // ---- the published key set --------------------------------------------------------------
  const doc = jwksDocument()
  check('publishes at least one key', doc.keys.length > 0)
  check(
    'every published key is a public EC P-256 sig key',
    doc.keys.every((k) => k.kty === 'EC' && k.crv === 'P-256' && k.alg === 'ES256' && k.use === 'sig'),
  )
  check(
    'NO private material is published (a private EC JWK carries `d`)',
    doc.keys.every((k) => (k as Record<string, unknown>).d === undefined),
  )
  check('the active kid is one we actually publish', findSigningKey(ACTIVE_KID) !== null)
  check('an unknown kid is not resolved', findSigningKey('nope') === null && findSigningKey(undefined) === null)

  // ---- signing ----------------------------------------------------------------------------
  process.env.TERMINAL_JWT_SECRET = HS_SECRET
  delete process.env.TERMINAL_JWT_PRIVATE_KEY

  const { signTerminalJwt } = await import('../../lib/terminals/terminal-jwt')

  const hsToken = await signTerminalJwt(P)
  check('with no private key set, signing stays HS256 (deploy is inert)', decodeProtectedHeader(hsToken).alg === 'HS256')
  check('…and carries no kid', decodeProtectedHeader(hsToken).kid === undefined)

  const hs = decodeJwt(hsToken)
  check('HS256 path carries role=authenticated', hs.role === 'authenticated')
  check('HS256 path carries aud=authenticated', hs.aud === 'authenticated')
  check('every claim our own API reads survives', hs.type === 'terminal' && hs.sub === P.terminal_id && hs.restaurant_id === P.restaurant_id)
  check(
    'permissions unchanged',
    JSON.stringify(hs.permissions) === JSON.stringify(['orders:read', 'orders:update', 'tables:read']),
  )

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  process.env.TERMINAL_JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const esToken = await signTerminalJwt(P)
  const esHeader = decodeProtectedHeader(esToken)
  check('with the private key set, signing becomes ES256', esHeader.alg === 'ES256')
  check('…and carries the active kid', esHeader.kid === ACTIVE_KID)
  const es = decodeJwt(esToken)
  check('ES256 path carries the same claim set', es.role === 'authenticated' && es.aud === 'authenticated' && es.type === 'terminal')

  // ---- verification accepts both ------------------------------------------------------------
  delete process.env.TERMINAL_JWT_PRIVATE_KEY
  const { requireTerminalAuth } = await import('../../lib/terminal-auth')
  const req = (t: string) => new Request('https://flashtap.app/x', { headers: { authorization: `Bearer ${t}` } })

  const legacy = await new SignJWT({ type: 'terminal', restaurant_id: P.restaurant_id, device_serial: 'x', permissions: [] })
    .setSubject(P.terminal_id)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(HS_SECRET))
  let legacyOk = false
  try {
    const r = await requireTerminalAuth(req(legacy))
    legacyOk = r.terminalId === P.terminal_id
  } catch {
    legacyOk = false
  }
  check('an HS256 token issued before the switch still verifies', legacyOk)

  const foreign = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const foreignKey = await importPKCS8(foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'ES256')

  const unknownKid = await new SignJWT({ type: 'terminal' })
    .setSubject('x')
    .setProtectedHeader({ alg: 'ES256', kid: randomUUID() })
    .setExpirationTime('1h')
    .sign(foreignKey)
  let unknownRejected = false
  try {
    await requireTerminalAuth(req(unknownKid))
  } catch {
    unknownRejected = true
  }
  check('an unknown kid is refused, not trusted for having a kid', unknownRejected)

  const forged = await new SignJWT({ type: 'terminal' })
    .setSubject('x')
    .setProtectedHeader({ alg: 'ES256', kid: ACTIVE_KID })
    .setExpirationTime('1h')
    .sign(foreignKey)
  let forgedRejected = false
  try {
    await requireTerminalAuth(req(forged))
  } catch {
    forgedRejected = true
  }
  check('a PUBLISHED kid signed by the wrong key is refused', forgedRejected)

  console.log('')
  if (failures.length) {
    console.error(`PHASE A VERIFY: ${failures.length} FAILED`)
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('PHASE A VERIFY: all assertions held.')
}

void main()
