import {NativeModules} from 'react-native';

const {RuntimeConfig} = NativeModules;

if (!RuntimeConfig?.API_BASE_URL) {
  throw new Error(
    '[FlashTap] RuntimeConfig.API_BASE_URL is not set. Build is misconfigured.',
  );
}

export const FLASHTAP_API_URL: string = RuntimeConfig.API_BASE_URL;
export const SUPABASE_URL: string = RuntimeConfig.SUPABASE_URL;
export const SUPABASE_ANON_KEY: string = RuntimeConfig.SUPABASE_ANON_KEY;
export const ENV_NAME: string = RuntimeConfig.ENV_NAME;
export const LOW_STOCK_THRESHOLD = 10;
export const TOKEN_STORAGE_KEY = 'flashtap_terminal_token';
export const REFRESH_TOKEN_STORAGE_KEY = 'flashtap_refresh_token';
export const RESTAURANT_ID_STORAGE_KEY = 'flashtap_restaurant_id';
export const TERMINAL_ID_STORAGE_KEY = 'flashtap_terminal_id';
export const RESTAURANT_NAME_STORAGE_KEY = 'flashtap_restaurant_name';
export const MERCHANT_NO_STORAGE_KEY = 'flashtap_merchant_no';
export const STORE_NO_STORAGE_KEY = 'flashtap_store_no';
export const PAYMENT_STATE_STORAGE_KEY = 'flashtap_payment_state';
/**
 * #344. A recovered orphaned card payment that could NOT be applied to the order on screen,
 * held until someone checks it. Never cleared by clearAllData: an unresolved card transaction
 * must outlive a logout, which is a staff action and not a decision about money.
 */
export const HELD_ORPHAN_PAYMENT_STORAGE_KEY = 'flashtap_held_orphan_payment';
/**
 * Developer toggle (Diagnostics): single source of truth for staff receipt printing
 * (auto-print, Print button, Reprint). Default off until hardware-verified.
 */
export const RECEIPT_PRINTING_ENABLED_KEY = 'flashtap_receipt_printing_enabled';
/** Last print attempt summary for Diagnostics (JSON). */
export const RECEIPT_PRINT_LAST_RESULT_KEY = 'flashtap_receipt_print_last_result';
// Kept in step with android/app/build.gradle versionName. These had drifted (1.71 here
// vs 1.72 in gradle) before the 74/1.73 bump; the on-screen diagnostics version is only
// useful if it names the build actually installed.
export const APP_VERSION = '2.20';

// ─── Payment timing (#346) ────────────────────────────────────────────────────

/**
 * THE ADVISORY CEILING, in seconds — when to stop telling the operator "please wait" and start
 * telling them something useful.
 *
 * MEASURED, NOT CHOSEN. Production, 894 card payments that actually settled, measured from
 * payment_attempt_started_at to paid_at on 2026-08-25:
 *
 *   p50 15s   p75 20s   p90 26s   p95 33s   p99 56s   max 284s
 *   93.3% settled by 30s     98.2% by 45s     99.4% by 60s
 *
 * 45s is the point where waiting longer stops being normal: fewer than 2 payments in 100 are still
 * legitimately in flight. Set it lower and the terminal cries wolf during ordinary sales, which is
 * how a warning stops being read. Set it higher and it lands after staff have already given up —
 * the median re-ring across the estate is 42s, so a ceiling of 60s would arrive too late to change
 * the behaviour it exists to change.
 */
export const PAYMENT_ADVISORY_CEILING_S = 45;

/**
 * THE HARD TIMEOUT on the launchPayment promise. There was none at all before this: the terminal
 * waited on WiseCashier forever.
 *
 * IT IS NOT THE SAME NUMBER AS THE ADVISORY CEILING AND MUST NOT BE COLLAPSED INTO IT. The ceiling
 * is when to tell a human something; this is when to stop waiting for a promise. A timeout that
 * fires on a payment which then succeeds converts a working sale into an unconfirmed one — the
 * exact defect it exists to prevent — so it has to clear the slowest payment that has ever
 * SUCCEEDED, not the slowest that is comfortable.
 *
 * The slowest successful payment on production is 284s (Mingle #371, N$210). 300s clears it.
 *
 * The 156s figure from the re-ring analysis is a DIFFERENT measurement — the p90 gap before staff
 * ring a sale again — and is far too short to use here: it sits below two payments that succeeded.
 */
export const PAYMENT_RESULT_TIMEOUT_MS = 300_000;
