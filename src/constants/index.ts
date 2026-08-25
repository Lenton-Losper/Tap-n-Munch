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
 * Developer toggle (Diagnostics): single source of truth for staff receipt printing
 * (auto-print, Print button, Reprint). Default off until hardware-verified.
 */
export const RECEIPT_PRINTING_ENABLED_KEY = 'flashtap_receipt_printing_enabled';
/** Last print attempt summary for Diagnostics (JSON). */
export const RECEIPT_PRINT_LAST_RESULT_KEY = 'flashtap_receipt_print_last_result';
// Kept in step with android/app/build.gradle versionName. These had drifted (1.71 here
// vs 1.72 in gradle) before the 74/1.73 bump; the on-screen diagnostics version is only
// useful if it names the build actually installed.
export const APP_VERSION = '1.91';
