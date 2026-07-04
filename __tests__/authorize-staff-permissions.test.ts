import { createClient } from '@supabase/supabase-js'
import { resolveStaffMemberId, authorize } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => admin,
}))

const TEST_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
const TEST_EMAIL = 'staging.kitchen.test@gmail.com'
const TEST_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORIGINAL_ROLE = 'kitchen'

describe('authorize staff_permissions via staff_members.id (staging)', () => {
  let staffMemberId: string | null = null

  beforeAll(async () => {
    const { data: existingMember } = await admin
      .from('staff_members')
      .select('id')
      .eq('restaurant_id', TEST_RESTAURANT_ID)
      .ilike('email', TEST_EMAIL)
      .maybeSingle()

    if (existingMember?.id) {
      staffMemberId = String(existingMember.id)
      return
    }

    const { data: inserted, error } = await admin
      .from('staff_members')
      .insert({
        restaurant_id: TEST_RESTAURANT_ID,
        email: TEST_EMAIL,
        role: ORIGINAL_ROLE,
        active: true,
      })
      .select('id')
      .single()

    if (error) throw error
    staffMemberId = String(inserted.id)
  })

  afterAll(async () => {
    if (!staffMemberId) return
    await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
    await admin.from('staff_members').delete().eq('id', staffMemberId)
  })

  beforeEach(async () => {
    if (!staffMemberId) return
    await admin.from('staff_permissions').delete().eq('staff_id', staffMemberId)
  })

  test('resolveStaffMemberId maps auth user to staff_members.id', async () => {
    const resolved = await resolveStaffMemberId(TEST_USER_ID, TEST_RESTAURANT_ID)
    expect(resolved).toBe(staffMemberId)
  })

  test('allow override grants permission not in role defaults', async () => {
    expect(await authorize(TEST_USER_ID, TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_VIEW)).toBe(false)

    const { error } = await admin.from('staff_permissions').insert({
      staff_id: staffMemberId,
      restaurant_id: TEST_RESTAURANT_ID,
      permission: PERMISSIONS.RECIPE_VIEW,
      effect: 'allow',
    })
    expect(error).toBeNull()

    expect(await authorize(TEST_USER_ID, TEST_RESTAURANT_ID, PERMISSIONS.RECIPE_VIEW)).toBe(true)
  })

  test('deny override revokes permission', async () => {
    const { error } = await admin.from('staff_permissions').insert({
      staff_id: staffMemberId,
      restaurant_id: TEST_RESTAURANT_ID,
      permission: PERMISSIONS.STOCK_VIEW,
      effect: 'deny',
    })
    expect(error).toBeNull()

    expect(await authorize(TEST_USER_ID, TEST_RESTAURANT_ID, PERMISSIONS.STOCK_VIEW)).toBe(false)
  })
})
