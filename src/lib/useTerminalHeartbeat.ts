import {useEffect} from 'react';
import {AppState, type AppStateStatus} from 'react-native';
import {APP_VERSION} from '../constants';
import {getTerminalToken} from './storage';
import {sendHeartbeat} from './api';

/** Unchanged from the value this replaced in OrdersScreen. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/**
 * THE HEARTBEAT BELONGS TO THE SESSION, NOT TO ONE SCREEN (#373).
 *
 * ============================================================================================
 * WHAT WAS WRONG
 * ============================================================================================
 *
 * This lived inside an effect in OrdersScreen, so it only ran while that screen was mounted. A
 * till parked on Tables, Settings or a payment flow — which is most of a shift — never sent its
 * version, and `restaurant_terminals.app_version` went stale or stayed null. It also fired only on
 * the INTERVAL, never on mount, so a freshly activated terminal reported nothing for five minutes
 * and a terminal that was never left open on Orders reported nothing at all.
 *
 * On 2026-09-02 that cost a long investigation: a waiter reported that marking a line collected
 * "reverted" it, the database was correct throughout, and the cause was a till running a build
 * older than the commit that taught the terminal the word `collected`. The one field that would
 * have answered "what is this device running?" in five seconds was null, so the version had to be
 * read off the physical device instead.
 *
 * ============================================================================================
 * WHAT THIS DOES
 * ============================================================================================
 *
 * Mounted once at the app root, so it runs for the life of the session regardless of screen.
 *
 *  - FIRES IMMEDIATELY on mount, so a terminal reports its version the moment it has a token
 *    rather than five minutes later. This is the half that fixes a fresh row reading null.
 *  - FIRES ON FOREGROUND, because a till asleep in a drawer overnight comes back with a
 *    `last_seen_at` and an `app_version` from yesterday, and the first thing anyone asks about a
 *    misbehaving device is what it is running.
 *  - Silently tolerates failure. A heartbeat is diagnostics; it must never surface an error to a
 *    waiter mid-service, and it must never block anything.
 *
 * No token means no heartbeat — an unactivated terminal has nothing to report and no credential
 * to report it with.
 */
/**
 * The work, separated from React so it can be tested the way subscribeLineChangeInvalidation is —
 * called directly, with fake timers, no renderer and no extra dependency. Returns its teardown.
 */
export function startTerminalHeartbeat(): () => void {
  let cancelled = false;

  const beat = async () => {
    try {
      const token = await getTerminalToken();
      if (!token || cancelled) {
        return;
      }
      await sendHeartbeat(token, APP_VERSION);
    } catch {
      // Diagnostics only. Never surfaced, never retried aggressively — the interval is the retry.
    }
  };

  void beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  const onAppState = (state: AppStateStatus) => {
    if (state === 'active') {
      void beat();
    }
  };
  const sub = AppState.addEventListener('change', onAppState);

  return () => {
  cancelled = true;
  clearInterval(timer);
  sub.remove();
  };
}

/** Mounted once at the app root. See App.tsx. */
export function useTerminalHeartbeat(): void {
  useEffect(() => startTerminalHeartbeat(), []);
}
