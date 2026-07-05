import { authorize, getRolePermissions } from '@/lib/permissions/authorize'
import { PERMISSIONS, ROLE_PERMISSIONS } from '@/lib/permissions'
import {
  STAGING_TEST_RESTAURANT_ID,
  STAGING_TEST_USER_ID,
  clearStagingStaffPermissionOverrides,
  createStagingAdmin,
  ensureStagingKitchenTestUser,
  ensureStagingStaffMember,
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

describe('JSON fallback when restaurant_roles missing (staging Phase 2 / 4A)', () => {
  let disposableRestaurantId: string | null = null

  afterAll(async () => {
    if (disposableRestaurantId) {
      await admin.from('restaurant_roles').delete().eq('restaurant_id', disposableRestaurantId)
      await admin.from('restaurants').delete().eq('id', disposableRestaurantId)
      disposableRestaurantId = null
    }
  })

  test('getRolePermissions falls back to JSON with warning when roles are absent', async () => {
    const slug = `fallback-${Date.now()}`
    const { data: restaurant, error: restaurantError } = await admin
      .from('restaurants')
      .insert({ name: `Fallback test ${slug}`, slug })
      .select('id')
      .single()

    if (restaurantError) throw restaurantError
    disposableRestaurantId = String(restaurant.id)

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
      originalWarn(...args)
    }

    try {
      const perms = await getRolePermissions(disposableRestaurantId!, 'kitchen')
      expect([...perms].sort()).toEqual([...(ROLE_PERMISSIONS.kitchen ?? [])].sort())
      expect(warnings.some((w) => w.includes('restaurant_roles missing'))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })
})
