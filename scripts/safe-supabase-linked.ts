#!/usr/bin/env npx tsx
/**
 * Mandatory guard for linked Supabase DDL / migration-history commands.
 *
 * Usage:
 *   npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> db query --linked -f path.sql
 *   npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> migration repair --linked --status applied VERSION
 *
 * See CONTRIBUTING.md — never run raw `supabase db query --linked` or
 * `supabase migration repair --linked` directly.
 */
import {
  SafeSupabaseLinkedError,
  runSafeSupabaseLinked,
} from './lib/safe-supabase-linked'

function printUsage(): void {
  console.error(`Usage:
  npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> db query --linked [options]
  npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> migration repair --linked [options]

Examples:
  npx tsx scripts/safe-supabase-linked.ts mdqjpxwczrhkxkbqatqa db query --linked -f supabase/migrations/foo.sql
  npx tsx scripts/safe-supabase-linked.ts mdqjpxwczrhkxkbqatqa migration repair --linked --status applied 20260705140000

Staging ref:    mdqjpxwczrhkxkbqatqa
Production ref: ihlmmpmolnpchzgwyhgh`)
}

function main(): void {
  const expectedRef = process.argv[2]
  const supabaseArgs = process.argv.slice(3)

  if (!expectedRef || expectedRef.startsWith('-') || supabaseArgs.length === 0) {
    printUsage()
    process.exit(1)
  }

  try {
    runSafeSupabaseLinked(expectedRef, supabaseArgs)
  } catch (error) {
    if (error instanceof SafeSupabaseLinkedError) {
      console.error(error.message)
      process.exit(error.exitCode)
    }
    throw error
  }
}

main()
