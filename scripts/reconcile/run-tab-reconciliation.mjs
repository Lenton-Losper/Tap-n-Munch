#!/usr/bin/env node
/**
 * Run scripts/reconcile/tab-reconciliation.sql for one tab and print (or return) its checks.
 *
 *   node scripts/reconcile/run-tab-reconciliation.mjs --container=ft-chaos-pg-rc-life --db=rc_life --tab=<uuid>
 *   node scripts/reconcile/run-tab-reconciliation.mjs ... --json            machine-readable rows
 *   node scripts/reconcile/run-tab-reconciliation.mjs ... --require=state   'state' rows must hold too
 *
 * LOCAL BY DESIGN. It reaches a database only through `docker exec <container> psql`, so it can
 * only ever touch a container on this machine; there is no host, port or connection-string option.
 * The SQL itself is READ ONLY (it runs inside BEGIN ... READ ONLY and ends in ROLLBACK), so the same
 * file can be handed to psql against any database -- a read replica, a restored backup -- by a
 * human who has chosen to do that; this runner does not.
 *
 * Exit 0 when every required row holds ('money' always; 'state' with --require=state), 1 when any
 * does not, 2 when the reconciliation could not run.
 *
 * Also importable: `reconcileTab({ container, db, tabId })` returns the parsed rows. The chaos
 * lifecycle scenario calls it at its final checkpoint.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RECONCILIATION_SQL = join(HERE, 'tab-reconciliation.sql')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function reconcileTab({ container, db, tabId, sql = readFileSync(RECONCILIATION_SQL, 'utf8') }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/.test(String(container))) throw new Error(`bad container name ${container}`)
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(String(db))) throw new Error(`bad database name ${db}`)
  if (!UUID.test(String(tabId))) throw new Error(`bad tab id ${tabId}`)
  const out = execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-F', '\t', '-v', `tab_id=${tabId}`],
    { input: sql, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  const rows = out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.includes('\t'))
    .map((l) => {
      const [check, severity, ok, expected, actual, delta, detail] = l.split('\t')
      return { check, severity, ok: ok === 't', expected: Number(expected), actual: Number(actual), delta: Number(delta), detail }
    })
  if (rows.length === 0) throw new Error(`reconciliation returned no rows:\n${out}`)
  return rows
}

export function failures(rows, { requireState = false } = {}) {
  return rows.filter((r) => !r.ok && (r.severity === 'money' || (requireState && r.severity === 'state')))
}

export function formatTable(rows) {
  const head = ['check', 'severity', 'ok', 'expected', 'actual', 'delta', 'detail']
  const body = rows.map((r) => [r.check, r.severity, r.ok ? 'OK' : 'FAIL', r.expected, r.actual, r.delta, r.detail].map(String))
  const widths = head.map((h, i) => Math.min(60, Math.max(h.length, ...body.map((b) => b[i].length))))
  const fmt = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(' | ')
  return [fmt(head), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(fmt)].join('\n')
}

// Main-module check by resolved path: a `file://` string comparison never matches on Windows.
const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  try {
    const rows = reconcileTab({ container: arg('container'), db: arg('db'), tabId: arg('tab') })
    const requireState = arg('require') === 'state'
    const bad = failures(rows, { requireState })
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      console.log(formatTable(rows))
      console.log(bad.length ? `\n${bad.length} required check(s) FAILED` : '\nall required checks hold')
    }
    process.exit(bad.length ? 1 : 0)
  } catch (e) {
    console.error(String(e.stderr || e.message))
    process.exit(2)
  }
}
