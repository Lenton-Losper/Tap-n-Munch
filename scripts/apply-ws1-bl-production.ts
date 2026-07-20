/**
 * Production: apply Workstream 1 -> Business & Locations migrations, plus the safe/inert
 * unrelated ones, in the corrected, dependency-respecting order. WhatsApp migrations
 * (20260712120000, 20260717120000, 20260717130000) are permanently excluded from this
 * script -- not a batch argument, never wired in here at all.
 *
 * Explicitly EXCLUDED from every batch below, pending a separate app-code-deploy decision:
 *   - 20260719100000_retire_users_restaurant_id.sql
 *   - 20260719150000_organization_stock_items_not_null.sql
 * Both require currently-deployed production app code (which still reads/writes
 * users.restaurant_id, and still inserts stock_items without organization_stock_item_id)
 * to be replaced first. Applying either now would break live behavior immediately.
 *
 *   npx tsx scripts/apply-ws1-bl-production.ts <batch>
 *   batch one of: 0 1 2 3 4 5
 */
import { config } from 'dotenv'
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
if (!url?.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing: not production Supabase (.env.production.local)')
}

const DIR = 'supabase/migrations/'

const BATCHES: Record<string, string[]> = {
  // Unrelated but safe/inert + behavior-preserving. WhatsApp ingress schema (empty, RLS
  // default-deny, zero live callers) + receipts Phase 1-3 schema/functions + the
  // behavior-preserving GRV numbering refactor. generate_document_number() here is a real
  // prerequisite for batch 3's stock_transfers.sql.
  '0': [
    '20260717100000_restaurant_whatsapp_accounts.sql',
    '20260717110000_whatsapp_conversations_and_messages.sql',
    '20260717140000_receipt_documents.sql',
    '20260717150000_grv_number_via_generate_document_number.sql',
    '20260717160000_receipt_deliveries_and_terminal_printer_configs.sql',
    '20260718100000_receipt_email_and_builtin_printer.sql',
  ],
  // Organizations schema + backfill. Riviera's dual-owner situation confirmed as a known
  // duplicate (both accounts belong to the same person) -- no manual override needed.
  '1': [
    '20260719110000_organizations_and_membership.sql',
    '20260719120000_organizations_backfill.sql',
  ],
  // Canonical stock items schema + backfill. NOT NULL tightening (20260719150000)
  // deliberately excluded -- paused pending the app-code decision.
  '2': [
    '20260719130000_organization_stock_items.sql',
    '20260719140000_organization_stock_items_backfill.sql',
    '20260719160000_create_restaurant_for_user_organization.sql',
  ],
  // Transfers schema + functions + the recipe-deduction advisory lock. Mandatory FNB
  // ChowNow Coke 600ml verification required after this batch before proceeding to batch 4.
  '3': [
    '20260719170000_stock_transfers.sql',
    '20260719180000_stock_movements_transfer_reasons.sql',
    '20260719190000_transfer_dispatch_receive_cancel_functions.sql',
    '20260719200000_deduct_recipe_stock_advisory_lock.sql',
  ],
  // WS4: permissions + RLS + create_transfer + the authenticated-grant revokes, shipped as
  // one window so the authenticated-callable gap on dispatch/receive/cancel is never left
  // open against real traffic between sub-steps.
  '4': [
    '20260719210000_stock_transfer_permissions_backfill.sql',
    '20260719220000_stock_transfers_rls.sql',
    '20260719230000_create_transfer_function.sql',
    '20260719240000_stock_transfers_rls_owner_only.sql',
    '20260719250000_cancel_transfer_permission.sql',
  ],
  // Business & Locations functions. Net-new, zero existing callers.
  '5': [
    '20260720100000_seed_restaurant_roles_function.sql',
    '20260720110000_create_organization_location_function.sql',
  ],
}

function versionOf(filename: string): string {
  const match = /^(\d+)_/.exec(filename)
  if (!match) throw new Error(`cannot parse version from ${filename}`)
  return match[1]
}

function main(): void {
  const batch = process.argv[2]
  const files = BATCHES[batch]
  if (!files) {
    throw new Error(`Unknown batch "${batch}". Valid: ${Object.keys(BATCHES).join(', ')}`)
  }

  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF}`)

  for (const file of files) {
    const path = DIR + file
    const version = versionOf(file)
    console.log(`\n--- applying ${file} ---`)
    runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, ['db', 'query', '--linked', '-f', path])
    runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, [
      'migration',
      'repair',
      '--linked',
      '--status',
      'applied',
      version,
    ])
  }

  console.log(`\nBATCH_${batch}_PRODUCTION_APPLY_OK (${files.length} migration(s))`)
}

main()
