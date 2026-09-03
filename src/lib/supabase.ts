import {createClient} from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SUPABASE_ANON_KEY, SUPABASE_URL} from '../constants';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * A SECOND, ISOLATED CLIENT — for the Phase B private invalidation channel only.
 *
 * `realtime.setAuth()` applies to a whole connection rather than one channel, so setting the
 * terminal-JWT on the shared client above would change the identity of the socket carrying the
 * public `restaurant-lines:<id>` channel that every terminal currently depends on. The private
 * path is unproven and must not be able to affect the one that works.
 *
 * Also built here rather than in realtimeInvalidation.ts so that constructing a client stays in
 * the module that owns clients: tests mock './supabase', and reaching past it into '../constants'
 * would drag NativeModules.RuntimeConfig into a jest environment that has no native modules.
 *
 * No session persistence and no auto-refresh: this client never signs in and must not touch the
 * AsyncStorage the real one uses.
 */
export function createPrivateChannelClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
