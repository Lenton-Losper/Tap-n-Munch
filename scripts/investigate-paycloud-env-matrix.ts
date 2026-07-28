/**
 * Read-only: fingerprint PayCloud env vars across Vercel environments + list CF Worker secrets.
 * Never prints full key bodies — only presence, length, sha256 fingerprint of normalized material.
 *
 * Trigger: [investigate-paycloud-env-matrix]
 *
 * Requires: VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID,
 *           CLOUDFLARE_API_TOKEN (+ optional CLOUDFLARE_API_TOKEN_SHADOW for production),
 *           CLOUDFLARE_ACCOUNT_ID
 */
import { createHash } from 'crypto'
import { execSync, spawnSync } from 'child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractPemBase64Body, normalizePublicKeyMaterialToPem } from '../payments/config.js'

const KEYS = [
  'PAYCLOUD_GATEWAY_PUBLIC_KEY',
  'PAYCLOUD_PRIVATE_KEY',
  'PAYCLOUD_APP_ID',
  'PAYCLOUD_ENDPOINT',
  'PAYCLOUD_MERCHANT_NO',
  'PAYCLOUD_STORE_NO',
  'PAYCLOUD_SIGNATURE_BASE64URL',
  'PAYCLOUD_SIGN_TYPE',
] as const

function log(label: string, value: unknown) {
  console.log(`\n===== ${label} =====`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function sha256Hex(s: string) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function fingerprintPublic(raw: string | undefined) {
  if (!raw) return null
  try {
    const pem = normalizePublicKeyMaterialToPem(raw)
    // SPKI der fingerprint (same as getPublicKeyFingerprint)
    const { createPublicKey, createHash } = require('crypto')
    const der = createPublicKey(pem).export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(der).digest('hex')
  } catch (e: any) {
    return `UNPARSEABLE:${e?.message || e}`
  }
}

function fingerprintPrivateDerivedPublic(raw: string | undefined) {
  if (!raw) return null
  try {
    const { createPrivateKey, createPublicKey, createHash } = require('crypto')
    const body = extractPemBase64Body(raw)
    let keyObj
    try {
      keyObj = createPrivateKey(`-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`)
    } catch {
      keyObj = createPrivateKey(`-----BEGIN RSA PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END RSA PRIVATE KEY-----`)
    }
    const der = createPublicKey(keyObj).export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(der).digest('hex')
  } catch (e: any) {
    return `UNPARSEABLE:${e?.message || e}`
  }
}

function summarizeValue(name: string, raw: string | undefined) {
  if (raw == null || raw === '') {
    return { present: false }
  }
  const base: Record<string, unknown> = {
    present: true,
    length: raw.length,
    value_sha256: sha256Hex(raw),
  }
  if (name === 'PAYCLOUD_ENDPOINT' || name === 'PAYCLOUD_APP_ID' || name === 'PAYCLOUD_MERCHANT_NO' || name === 'PAYCLOUD_STORE_NO' || name === 'PAYCLOUD_SIGNATURE_BASE64URL' || name === 'PAYCLOUD_SIGN_TYPE') {
    // Non-secret identifiers — print redacted / full for endpoint
    if (name === 'PAYCLOUD_ENDPOINT') base.value = raw.trim()
    else if (name === 'PAYCLOUD_SIGNATURE_BASE64URL' || name === 'PAYCLOUD_SIGN_TYPE') base.value = raw.trim()
    else base.value_prefix = `${raw.trim().slice(0, 4)}…${raw.trim().slice(-3)}`
  }
  if (name === 'PAYCLOUD_GATEWAY_PUBLIC_KEY') {
    base.spki_fingerprint_sha256 = fingerprintPublic(raw)
  }
  if (name === 'PAYCLOUD_PRIVATE_KEY') {
    base.derived_public_spki_fingerprint_sha256 = fingerprintPrivateDerivedPublic(raw)
  }
  return base
}

function vercelEnvPull(environment: string): Record<string, string> {
  const token = process.env.VERCEL_TOKEN || ''
  const org = process.env.VERCEL_ORG_ID || ''
  const project = process.env.VERCEL_PROJECT_ID || ''
  if (!token || !org || !project) {
    throw new Error('Missing VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID')
  }
  const dir = join(tmpdir(), `vercel-env-${environment}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ orgId: org, projectId: project }),
  )
  // vercel pull writes .vercel/.env.<environment>.local
  const r = spawnSync(
    'npx',
    ['vercel@41.3.0', 'pull', '--yes', `--environment=${environment}`, `--token=${token}`],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, VERCEL_ORG_ID: org, VERCEL_PROJECT_ID: project } },
  )
  log(`VERCEL_PULL_${environment}_STATUS`, { status: r.status, stderr: (r.stderr || '').slice(-800) })
  const candidates = [
    join(dir, `.vercel`, `.env.${environment}.local`),
    join(dir, `.env.${environment}.local`),
    join(dir, `.vercel`, `.env.production.local`),
  ]
  let envFile = candidates.find((p) => existsSync(p))
  if (!envFile) {
    // list dir for debugging
    try {
      log(`VERCEL_PULL_${environment}_DIR`, execSync('find . -maxdepth 3 -type f', { cwd: dir, encoding: 'utf8' }))
    } catch {}
    return {}
  }
  const text = readFileSync(envFile, 'utf8')
  const out: Record<string, string> = {}
  for (const line of text.split(/\n/)) {
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const k = line.slice(0, eq)
    let v = line.slice(eq + 1)
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    // unescape common sequences
    v = v.replace(/\\n/g, '\n')
    out[k] = v
  }
  return out
}

function vercelEnvLs(): string {
  const token = process.env.VERCEL_TOKEN || ''
  const org = process.env.VERCEL_ORG_ID || ''
  const project = process.env.VERCEL_PROJECT_ID || ''
  const dir = join(tmpdir(), `vercel-ls-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, '.vercel'), { recursive: true })
  writeFileSync(join(dir, '.vercel', 'project.json'), JSON.stringify({ orgId: org, projectId: project }))
  const r = spawnSync('npx', ['vercel@41.3.0', 'env', 'ls', `--token=${token}`], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, VERCEL_ORG_ID: org, VERCEL_PROJECT_ID: project },
  })
  return `status=${r.status}\n${r.stdout || ''}\n${r.stderr || ''}`
}

function wranglerSecretList(config?: string): string {
  const args = ['wrangler@3.99.0', 'secret', 'list']
  if (config) args.push('--config', config)
  const r = spawnSync('npx', args, {
    encoding: 'utf8',
    env: process.env,
  })
  return `status=${r.status}\n${r.stdout || ''}\n${(r.stderr || '').slice(-500)}`
}

async function main() {
  log('VERCEL_ENV_LS', vercelEnvLs())

  const matrix: Record<string, any> = {}
  for (const envName of ['production', 'preview', 'development'] as const) {
    try {
      const vars = vercelEnvPull(envName)
      const row: Record<string, any> = {}
      for (const k of KEYS) {
        row[k] = summarizeValue(k, vars[k])
      }
      row._gateway_equals_derived =
        row.PAYCLOUD_GATEWAY_PUBLIC_KEY?.spki_fingerprint_sha256 &&
        row.PAYCLOUD_PRIVATE_KEY?.derived_public_spki_fingerprint_sha256
          ? row.PAYCLOUD_GATEWAY_PUBLIC_KEY.spki_fingerprint_sha256 ===
            row.PAYCLOUD_PRIVATE_KEY.derived_public_spki_fingerprint_sha256
          : null
      row._endpoint_is_sandbox = String(row.PAYCLOUD_ENDPOINT?.value || '').includes('wiseasy-open')
      row._endpoint_is_live = String(row.PAYCLOUD_ENDPOINT?.value || '').includes('open.finatic.africa')
      matrix[`vercel_${envName}`] = row
    } catch (e: any) {
      matrix[`vercel_${envName}`] = { error: String(e?.message || e) }
    }
  }
  log('VERCEL_PAYCLOUD_MATRIX', matrix)

  // Cloudflare: secret names only (values are not readable via API after set)
  process.env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || ''
  log('CF_STAGING_SECRET_LIST', wranglerSecretList())
  if (process.env.CLOUDFLARE_API_TOKEN_SHADOW) {
    const prev = process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN_SHADOW
    log('CF_PRODUCTION_SECRET_LIST', wranglerSecretList('wrangler.production.toml'))
    process.env.CLOUDFLARE_API_TOKEN = prev
  } else {
    log('CF_PRODUCTION_SECRET_LIST', { skipped: true, reason: 'CLOUDFLARE_API_TOKEN_SHADOW not in job env' })
  }

  // Compare known production fingerprint from prior KEYDIAG
  log('KNOWN_PRODUCTION_FINGERPRINT_FROM_PRIOR_INVESTIGATION', {
    configured_and_derived: '1e5dcffc7f814c75e6cab7f1ab348879206956f555807998178a53ec95db2783',
    note: 'CF Worker secret values are not exportable; prior KEYDIAG showed configured===derived (wrong gateway key).',
    historical_working_gateway: 'ad7ccabe6acf3461569c893c9e215ee74c6308b0d57e5412af3d267151b4d47e',
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
