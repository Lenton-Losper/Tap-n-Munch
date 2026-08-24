export const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808';
export const MINT_LEAF_ID = '13f496c9-0621-4203-9379-e9caad5695ef';
export const RIVIERA_MERCHANT = '342400001004';
export const RIVIERA_STORE = '4424000013';
export const P5_TERMINAL_SN = '6fdf0e73';
export const DEV_PHONE_SN = '0ccdbf19965fecb6';
export const SHARED_CHECKOUT_MERCHANT = '342600032359';
export const SHARED_CHECKOUT_STORE = '4426010221';
export const VALID_ORDER_STATUSES = ['pending', 'accepted', 'ready', 'completed', 'cancelled', 'PENDING', 'ACCEPTED', 'READY', 'COMPLETE', 'CANCELLED'];
// 'card_payment' is written by migration 20260531120000 and 'abandoned' by 20260824150000
// (#333, the tab reaper). Both were missing, so this list would have failed on any card-settled
// tab too -- it was already wrong before #333 exposed it. Checked the read side for a
// cross-layer break and there is none: no exhaustive switch on settled_type exists anywhere,
// and the only discriminator is a single === 'card_payment' in lib/tab-session.ts.
export const VALID_SETTLED_TYPES = ['cash', 'card', 'split', 'qr', 'manual_close', 'card_payment', 'abandoned'];
export const CHOWNOW_ID = 'b161c758-582d-4dfa-839a-9fa35c492a49';
export const CHOWNOW_KIOSK_TABLE_ID = '0cc87cbf-dc65-4687-9bcc-ab2cf1a20952';
export const VALID_ROLES = ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar'];
export const VALID_PAYMENT_METHODS = ['cash', 'card', 'hosted_checkout', 'eft', 'voucher', 'mobile_money'];
export const VALID_FEATURE_KEYS = [
  'kitchen_enabled', 'inventory_enabled', 'analytics_enabled',
  'split_bill_enabled', 'reservations_enabled', 'loyalty_enabled',
  'online_payments_enabled', 'multi_branch_enabled', 'staff_app_enabled',
  'kiosk_enabled', 'whatsapp_enabled',
];
