import { appendFileSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'

export const STAGING_PROJECT_REF = 'mdqjpxwczrhkxkbqatqa'
export const PRODUCTION_PROJECT_REF = 'ihlmmpmolnpchzgwyhgh'

const LINKED_PROJECT_REL = join('supabase', '.temp', 'linked-project.json')
const AUDIT_LOG_REL = join('supabase', '.temp', 'safe-supabase-linked-audit.log')

/** ExecSyncOptions.shell is string-only (not boolean); pick the platform shell explicitly. */
function resolveExecShell(): string {
  return process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
}

/** Run a shell command with inherited stdio (cross-platform, tsc-safe). */
export function runShellCommand(command: string, options?: { cwd?: string }): void {
  execSync(command, {
    cwd: options?.cwd,
    stdio: 'inherit',
    shell: resolveExecShell(),
  })
}

export class SafeSupabaseLinkedError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'SafeSupabaseLinkedError'
    this.exitCode = exitCode
  }
}

function linkedProjectPath(cwd: string): string {
  return join(cwd, LINKED_PROJECT_REL)
}

function auditLogPath(cwd: string): string {
  return join(cwd, AUDIT_LOG_REL)
}

export function readLinkedProjectRef(cwd = process.cwd()): string {
  const path = linkedProjectPath(cwd)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new SafeSupabaseLinkedError(
      `SAFE-SUPABASE-LINKED ABORT: cannot read ${path}. Run: npx supabase link --project-ref <expected-project-ref>`,
    )
  }

  let parsed: { ref?: unknown }
  try {
    parsed = JSON.parse(raw) as { ref?: unknown }
  } catch {
    throw new SafeSupabaseLinkedError(
      `SAFE-SUPABASE-LINKED ABORT: invalid JSON in ${path}`,
    )
  }

  const ref = String(parsed.ref ?? '').trim()
  if (!ref) {
    throw new SafeSupabaseLinkedError(
      `SAFE-SUPABASE-LINKED ABORT: missing "ref" in ${path}`,
    )
  }
  return ref
}

export function assertAllowedSupabaseArgs(args: string[]): void {
  const isDbQueryLinked =
    args[0] === 'db' && args[1] === 'query' && args[2] === '--linked'
  const isMigrationRepairLinked =
    args[0] === 'migration' && args[1] === 'repair' && args[2] === '--linked'

  if (!isDbQueryLinked && !isMigrationRepairLinked) {
    throw new SafeSupabaseLinkedError(
      'SAFE-SUPABASE-LINKED ABORT: only these commands are permitted:\n' +
        '  db query --linked ...\n' +
        '  migration repair --linked ...\n' +
        `Received: supabase ${args.join(' ')}`,
    )
  }
}

export function formatAbortMessage(expectedRef: string, linkedRef: string, cwd = process.cwd()): string {
  return [
    'SAFE-SUPABASE-LINKED ABORT: linked project ref does not match expected ref.',
    `  expected: ${expectedRef}`,
    `  linked:   ${linkedRef}`,
    `  file:     ${linkedProjectPath(cwd)}`,
    '',
    'Fix with:',
    `  npx supabase link --project-ref ${expectedRef}`,
    '',
    'Never run raw `supabase db query --linked` or `supabase migration repair --linked`.',
    'Always use: npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> <command...>',
  ].join('\n')
}

function appendAuditLog(
  cwd: string,
  expectedRef: string,
  linkedRef: string,
  args: string[],
): void {
  const line =
    `${new Date().toISOString()}` +
    `\tverified_ref=${linkedRef}` +
    `\texpected_ref=${expectedRef}` +
    `\tcommand=supabase ${args.join(' ')}` +
    '\n'
  appendFileSync(auditLogPath(cwd), line, { encoding: 'utf8' })
}

/**
 * Run a guarded Supabase CLI command against the linked project.
 * Aborts unless linked-project.json ref exactly matches expectedRef.
 */
export function runSafeSupabaseLinked(
  expectedRef: string,
  supabaseArgs: string[],
  options?: { cwd?: string },
): void {
  const cwd = options?.cwd ?? process.cwd()
  const expected = String(expectedRef ?? '').trim()
  if (!expected) {
    throw new SafeSupabaseLinkedError(
      'SAFE-SUPABASE-LINKED ABORT: expected project ref is required (no default).',
    )
  }

  assertAllowedSupabaseArgs(supabaseArgs)

  const linkedRef = readLinkedProjectRef(cwd)
  if (linkedRef !== expected) {
    throw new SafeSupabaseLinkedError(formatAbortMessage(expected, linkedRef, cwd))
  }

  const quotedArgs = supabaseArgs.map((arg) => {
    if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg
    return `"${arg.replace(/"/g, '\\"')}"`
  })
  const command = `npx supabase ${quotedArgs.join(' ')}`
  runShellCommand(command, { cwd })

  appendAuditLog(cwd, expected, linkedRef, supabaseArgs)
  console.log(
    `[safe-supabase-linked] OK ${new Date().toISOString()} verified_ref=${linkedRef} command=supabase ${supabaseArgs.join(' ')}`,
  )
}
