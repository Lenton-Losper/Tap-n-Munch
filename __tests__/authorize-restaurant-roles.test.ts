import { authorize, getRolePermissions } from '@/lib/permissions/authorize'
import { PERMISSIONS, ROLE_PERMISSIONS } from '@/lib/permissions'
import {
  STAGING_TEST_RESTAURANT_ID,
  STAGING_TEST_USER_ID,
  clearStagingStaffPermissionOverrides,
  createStagingAdmin,
  ensureStagingKitchenTestUser,
  ensureStagingStaffMember,
  restoreRestaurantRoles,
} from './helpers/staging-auth-fixtures'

const admin = createStagingAdmin()

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => admin,
}))

let sharedStaffMemberId: string | null = null

/** Runs before every describe — clears stray staff_permissions from ad-hoc scripts or prior runs. */
beforeAll(async () => {
  await ensureStagingKitchenTestUser(admin)
  sharedStaffMemberId = await ensureStagingStaffMember(admin)
  await clearStagingStaffPermissionOverrides(admin, sharedStaffMemberId)
})

beforeEach(async () => {
  if (!sharedStaffMemberId) {
    await ensureStagingKitchenTestUser(admin)
    sharedStaffMemberId = await ensureStagingStaffMember(admin)
  }
  await clearStagingStaffPermissionOverrides(admin, sharedStaffMemberId)
})

describe('authorize() with restaurant_roles (staging Phase 2)', () => {
  test('kitchen user permissions match JSON baseline via DB', async () => {
    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_EDIT)).toBe(
      false,
    )
    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.STOCK_VIEW)).toBe(
      true,
    )
    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.ORDERS_UPDATE)).toBe(
      true,
    )
    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.STOCK_RECEIVE)).toBe(
      false,
    )
    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.ANALYTICS_VIEW)).toBe(
      false,
    )
  })

  test('owner permissions match JSON baseline via DB', async () => {
    const { data: ownerRow } = await admin
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .eq('role', 'owner')
      .maybeSingle()

    if (!ownerRow?.user_id) {
      console.warn('No owner row on staging Riviera — skipping owner regression checks')
      return
    }

    const ownerId = String(ownerRow.user_id)
    expect(await authorize(ownerId, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.SETTINGS_WRITE)).toBe(true)
    expect(await authorize(ownerId, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.STOCK_RECEIVE)).toBe(true)
    expect(await authorize(ownerId, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.ANALYTICS_VIEW)).toBe(true)
  })

  test('manager stock:receive matches JSON baseline via DB', async () => {
    const { data: managerRow } = await admin
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .eq('role', 'manager')
      .maybeSingle()

    if (!managerRow?.user_id) {
      console.warn('No manager row on staging Riviera — skipping manager regression check')
      return
    }

    expect(
      await authorize(String(managerRow.user_id), STAGING_TEST_RESTAURANT_ID, PERMISSIONS.STOCK_RECEIVE),
    ).toBe(true)
  })
})

describe('staff_permissions overrides on DB-backed defaults (staging Phase 2)', () => {
  let staffMemberId: string | null = null

  beforeAll(async () => {
    await ensureStagingKitchenTestUser(admin)
    staffMemberId = await ensureStagingStaffMember(admin)
  })

  afterAll(async () => {
    if (!staffMemberId) return
    await clearStagingStaffPermissionOverrides(admin, staffMemberId)
    staffMemberId = null
  })

  beforeEach(async () => {
    if (!staffMemberId) return
    await clearStagingStaffPermissionOverrides(admin, staffMemberId)
  })

  afterEach(async () => {
    if (!staffMemberId) return
    await clearStagingStaffPermissionOverrides(admin, staffMemberId)
  })

  test('allow override grants permission not in role defaults', async () => {
    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_VIEW)).toBe(
      false,
    )

    const { error } = await admin.from('staff_permissions').insert({
      staff_id: staffMemberId,
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      permission: PERMISSIONS.RECIPE_VIEW,
      effect: 'allow',
    })
    expect(error).toBeNull()

    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_VIEW)).toBe(
      true,
    )
  })

  test('deny override revokes permission', async () => {
    const { error } = await admin.from('staff_permissions').insert({
      staff_id: staffMemberId,
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      permission: PERMISSIONS.STOCK_VIEW,
      effect: 'deny',
    })
    expect(error).toBeNull()

    expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.STOCK_VIEW)).toBe(
      false,
    )
  })
})

describe('JSON fallback when restaurant_roles missing (staging Phase 2)', () => {
  let backup: Array<Record<string, unknown>> = []
  let staffMemberId: string | null = null

  beforeAll(async () => {
    await ensureStagingKitchenTestUser(admin)
    staffMemberId = await ensureStagingStaffMember(admin)

    const { data, error } = await admin
      .from('restaurant_roles')
      .select('*')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)

    if (error) throw error
    backup = data ?? []
    if (backup.length !== 6) {
      throw new Error(
        `Expected 6 restaurant_roles rows for backup, got ${backup.length}. ` +
          'Run auth v2 seed migrations before these tests.',
      )
    }
  })

  beforeEach(async () => {
    await restoreRestaurantRoles(admin, STAGING_TEST_RESTAURANT_ID, backup)
    if (staffMemberId) {
      await clearStagingStaffPermissionOverrides(admin, staffMemberId)
    }
  })

  afterAll(async () => {
    await restoreRestaurantRoles(admin, STAGING_TEST_RESTAURANT_ID, backup)
    if (staffMemberId) {
      await clearStagingStaffPermissionOverrides(admin, staffMemberId)
    }
  })

  test('getRolePermissions and authorize fall back to JSON with warning', async () => {
    const { error: deleteError } = await admin
      .from('restaurant_roles')
      .delete()
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)

    expect(deleteError).toBeNull()

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
      originalWarn(...args)
    }

    try {
      const perms = await getRolePermissions(STAGING_TEST_RESTAURANT_ID, 'kitchen')
      expect([...perms].sort()).toEqual([...(ROLE_PERMISSIONS.kitchen ?? [])].sort())
      expect(warnings.some((w) => w.includes('restaurant_roles missing'))).toBe(true)

      if (staffMemberId) {
        await clearStagingStaffPermissionOverrides(admin, staffMemberId)
      }

      expect(await authorize(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID, PERMISSIONS.STOCK_VIEW)).toBe(
        true,
      )
    } finally {
      console.warn = originalWarn
      await restoreRestaurantRoles(admin, STAGING_TEST_RESTAURANT_ID, backup)
    }
  })
})
