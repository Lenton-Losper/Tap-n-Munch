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

    /**
     * PRECONDITION, RE-READ RATHER THAN ASSUMED.
     *
     * This suite shares ONE fixture staff_member with authorize-staff-permissions.test.ts —
     * unavoidably, because resolveStaffMemberId links a user to staff_members by email — and its
     * setup clears that member's overrides. A concurrent run (another CI run, or a session running
     * these tests locally against the same staging project) deletes the row we just inserted, and
     * the assertion below then reads `false` from an `allow` that no longer exists.
     *
     * That is what went red on 2026-08-28, and the bare "expected true got false" sent a reader
     * looking for a bug in authorize() that was never there. Re-reading the row first means an
     * interference failure says so in its own message. The workflow now serialises staging runs;
     * this catches the case that serialisation cannot cover.
     */
    const { data: persisted } = await admin
      .from('staff_permissions')
      .select('permission, effect')
      .eq('staff_id', staffMemberId)
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .eq('permission', PERMISSIONS.RECIPE_VIEW)
      .maybeSingle()

    if (persisted?.effect !== 'allow') {
      throw new Error(
        'INTERFERENCE, NOT A DEFECT IN authorize(): the allow override for recipe:view was gone ' +
          'before authorize() read it. Another run against this shared staging fixture cleared ' +
          `it (found: ${JSON.stringify(persisted)}). Check for a concurrent staging CI run or a ` +
          'local session running the authorize- suites against the same project.',
      )
    }

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
