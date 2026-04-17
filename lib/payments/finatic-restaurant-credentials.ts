import { adminDb } from '@/lib/firebase/admin-firestore'

type AdminFirestore = NonNullable<ReturnType<typeof adminDb>>

/**
 * Same merchant/store resolution as checkout (`app/api/orders/route.ts`):
 * restaurant `finatic_merchant_no` / `finatic_store_no` when set, else
 * `PAYCLOUD_MERCHANT_NO` / `PAYCLOUD_STORE_NO`.
 */
export async function getRestaurantFinaticCredentials(
  fs: AdminFirestore,
  restaurantId: string
): Promise<{ merchantNo: string; storeNo: string }> {
  const snap = await fs.doc(`restaurants/${restaurantId}`).get()
  const data = snap.exists ? (snap.data() as Record<string, unknown>) : {}
  const merchantNo = String(data?.finatic_merchant_no || process.env.PAYCLOUD_MERCHANT_NO || '').trim()
  const storeNo = String(data?.finatic_store_no || process.env.PAYCLOUD_STORE_NO || '').trim()
  return { merchantNo, storeNo }
}
