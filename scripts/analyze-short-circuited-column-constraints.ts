/**
 * READ-ONLY repo analysis for #193 and its pattern class.
 *
 * Finds every `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` subcommand that carries a
 * column constraint (CHECK / NOT NULL / DEFAULT / REFERENCES / UNIQUE) and reports
 * whether that same (table, column) was already declared by an EARLIER migration.
 *
 * Why it matters: PostgreSQL skips the ENTIRE AddColumn subcommand when the column
 * already exists ("column ... already exists, skipping"). Every constraint attached
 * to that subcommand is silently discarded with it. The migration file therefore
 * documents a constraint the database does not have.
 *
 * Touches no database. Reads supabase/migrations/*.sql only.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations')

type Decl = {
  file: string
  table: string
  column: string
  kind: 'create-table' | 'add-column'
  constraints: string[]
  raw: string
}

/** Strip line and block comments so commented-out SQL never counts as a declaration. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '')
}

/** Split a parenthesised column list on top-level commas only. */
function splitTopLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

function constraintsOf(fragment: string): string[] {
  const f = fragment.replace(/\s+/g, ' ')
  const found: string[] = []
  if (/\bCHECK\s*\(/i.test(f)) {
    const m = f.match(/\bCHECK\s*(\((?:[^()]|\([^()]*\))*\))/i)
    found.push(`CHECK ${m ? m[1].replace(/\s+/g, ' ') : '(?)'}`)
  }
  if (/\bNOT\s+NULL\b/i.test(f)) found.push('NOT NULL')
  if (/\bDEFAULT\b/i.test(f)) {
    const m = f.match(/\bDEFAULT\s+([^\s,]+(?:\([^)]*\))?)/i)
    found.push(`DEFAULT ${m ? m[1] : '?'}`)
  }
  if (/\bREFERENCES\b/i.test(f)) found.push('REFERENCES')
  if (/\bUNIQUE\b/i.test(f)) found.push('UNIQUE')
  if (/\bPRIMARY\s+KEY\b/i.test(f)) found.push('PRIMARY KEY')
  return found
}

const unquote = (s: string) => s.replace(/"/g, '').replace(/^public\./i, '').toLowerCase()

function parse(file: string, sql: string): Decl[] {
  const clean = stripComments(sql)
  const decls: Decl[] = []

  // CREATE TABLE [IF NOT EXISTS] <t> ( ... )
  const ct = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w".]+)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = ct.exec(clean))) {
    const table = unquote(m[1])
    let depth = 1
    let i = ct.lastIndex
    while (i < clean.length && depth > 0) {
      if (clean[i] === '(') depth++
      if (clean[i] === ')') depth--
      i++
    }
    const body = clean.slice(ct.lastIndex, i - 1)
    for (const frag of splitTopLevel(body)) {
      const t = frag.trim()
      // skip table-level constraint clauses; we want column definitions
      if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(t)) continue
      const nameMatch = t.match(/^([\w"]+)/)
      if (!nameMatch) continue
      decls.push({
        file,
        table,
        column: unquote(nameMatch[1]),
        kind: 'create-table',
        constraints: constraintsOf(t),
        raw: t.replace(/\s+/g, ' ').slice(0, 160),
      })
    }
  }

  // ALTER TABLE <t> ... ADD COLUMN [IF NOT EXISTS] <c> ...
  // One ALTER may carry several comma-separated ADD COLUMN subcommands.
  const at = /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w".]+)([\s\S]*?);/gi
  while ((m = at.exec(clean))) {
    const table = unquote(m[1])
    const bodyRaw = m[2]
    for (const frag of splitTopLevel(bodyRaw)) {
      const t = frag.trim()
      const add = t.match(/ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?([\w"]+)([\s\S]*)/i)
      if (!add) continue
      decls.push({
        file,
        table,
        column: unquote(add[2]),
        kind: 'add-column',
        constraints: constraintsOf(add[3]),
        raw: (add[1] ? 'ADD COLUMN IF NOT EXISTS ' : 'ADD COLUMN ') +
          add[2] + ' ' + add[3].replace(/\s+/g, ' ').trim().slice(0, 160),
      })
    }
  }

  return decls
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
const all: Decl[] = []
for (const f of files) all.push(...parse(f, readFileSync(join(MIGRATIONS, f), 'utf8')))

// First declaration of each (table, column), in lexical migration order = apply order.
const first = new Map<string, Decl>()
for (const d of all) {
  const k = `${d.table}.${d.column}`
  if (!first.has(k)) first.set(k, d)
}

console.log('='.repeat(78))
console.log('SHORT-CIRCUITED COLUMN CONSTRAINTS — constraint-carrying redeclarations')
console.log('='.repeat(78))

let n = 0
for (const d of all) {
  if (d.kind !== 'add-column') continue
  if (d.constraints.length === 0) continue
  const k = `${d.table}.${d.column}`
  const f = first.get(k)!
  if (f.file === d.file && f.raw === d.raw) continue // it IS the first declaration
  n++
  console.log(`\n[${n}] ${k}`)
  console.log(`    FIRST  ${f.file}  (${f.kind})`)
  console.log(`           ${f.raw}`)
  console.log(`           constraints: ${f.constraints.join(' | ') || '(none)'}`)
  console.log(`    LATER  ${d.file}`)
  console.log(`           ${d.raw}`)
  console.log(`           constraints: ${d.constraints.join(' | ') || '(none)'}   <-- DISCARDED if column pre-exists`)
}
console.log(`\nTotal constraint-carrying redeclarations: ${n}`)
