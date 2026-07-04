import { resolveStaffMemberId, authorize } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import {
  STAGING_TEST_RESTAURANT_ID,
  STAGING_TEST_USER_ID,
  cleanupStagingStaffMember,
  createStagingAdmin,
  ensureStagingKitchenTestUser,
  ensureStagingStaffMember,
} from './helpers/staging-auth-fixtures'

const admin = createStagingAdmin()

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => admin,
}))

describe('authorize staff_permissions via staff_members.id (staging)', () => {
  let staffMemberId: string | null = null

  beforeAll(async () => {
    await ensureStagingKitchenTestUser(admin)
    staffMemberId = await ensureStagingStaffMember(admin)
  })

  afterAll(async () => {
    if (!staffMemberId) return
    await cleanupStagingStaffMember(admin, staffMemberId)
    staffMemberId = null
  })

  beforeEach(async () => {
    if (!staffMemberId) return
    await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
  })

  test('resolveStaffMemberId maps auth user to staff_members.id', async () => {
    const resolved = await resolveStaffMemberId(STAGING_TEST_USER_ID, STAGING_TEST_RESTAURANT_ID)
    expect(resolved).toBe(staffMemberId)
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
