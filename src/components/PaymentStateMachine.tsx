import React, {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {StyleSheet, Text, View} from 'react-native';
import {PAYMENT_STATE_STORAGE_KEY} from '../constants';
import {
  UNCONFIRMED_INTERRUPTED,
  UNCONFIRMED_TITLE,
} from '../constants/paymentCopy';
import {
  PaymentAction,
  PaymentMachineState,
  PaymentState,
} from '../types';

const INITIAL_STATE: PaymentMachineState = {state: 'IDLE'};

function paymentReducer(
  state: PaymentMachineState,
  action: PaymentAction,
): PaymentMachineState {
  switch (action.type) {
    case 'START_PAYMENT':
      return {
        state: 'PAYMENT_IN_PROGRESS',
        orderId: action.orderId,
        amount: action.amount,
        reference: undefined,
        error: undefined,
      };
    case 'PAYMENT_SUCCESS':
      return {
        ...state,
        state: 'PAYMENT_SUCCESS',
        reference: action.reference,
        error: undefined,
      };
    case 'PAYMENT_FAILED':
      return {
        ...state,
        state: 'PAYMENT_FAILED',
        error: action.error,
      };
    /**
     * #327. Reuses `error` as the detail slot rather than adding a field: the machine is persisted
     * to AsyncStorage and every extra key is one more thing a restored legacy payload can be
     * missing. `reference` is cleared because there is, by definition, no confirmed payment to
     * reference — leaving a stale one would let the success screen's reference line survive into a
     * state that is explicitly NOT a success.
     */
    case 'PAYMENT_UNCONFIRMED':
      return {
        ...state,
        state: 'PAYMENT_UNCONFIRMED',
        reference: undefined,
        error: action.detail,
      };
    case 'RESET':
      return INITIAL_STATE;
    case 'RESTORE':
      return action.payload;
    default:
      return state;
  }
}

/**
 * E4 / E6 (RC sprint 2026-09-30). ONE RECORD PER ORDER, not one slot for the whole device.
 *
 * The single `flashtap_payment_state` slot lost an uncertain payment three ways, each of which put
 * a live "Process Payment" back in front of the waiter for an order whose card may have been
 * charged -- a second SALE under the same merchant order number:
 *   1. Back / hardware back ran reset(), and the persist effect then REMOVED the slot;
 *   2. opening ANY other order's Charge screen dropped the slot as "another order's state";
 *   3. every POS sale called clearPersistedPaymentState(), which removed it.
 * Keyed by order, a record is only ever written or removed by that order's own machine.
 */
export function paymentStateStorageKey(orderId?: string): string {
  return orderId ? `${PAYMENT_STATE_STORAGE_KEY}:${orderId}` : PAYMENT_STATE_STORAGE_KEY;
}

/** The two states worth surviving a restart. Everything else is removed on write. */
export function holdsRecoveryState(state: PaymentMachineState['state']): boolean {
  return state === 'PAYMENT_IN_PROGRESS' || state === 'PAYMENT_UNCONFIRMED';
}

async function persistPaymentState(
  state: PaymentMachineState,
  orderId?: string,
): Promise<void> {
  const key = paymentStateStorageKey(orderId);
  // Only crash-recover in-flight payments. Never persist SUCCESS/FAILED — otherwise
  // Sale → Charge for a new order hydrates a prior success and skips Finatic.
  //
  // PAYMENT_UNCONFIRMED IS THE ONE TERMINAL STATE WORTH PERSISTING (#327). Losing it on a restart
  // loses the only thing standing between an unconfirmed payment and released food, and the
  // reasons the other two are not persisted do not apply to it: a stale SUCCESS is dangerous
  // because it claims money arrived, and a stale FAILED is noise, but a stale UNCONFIRMED merely
  // repeats "check this before releasing", which is never the wrong instruction. The two guards
  // that already contain a stale payload cover it unchanged — hydrate() ignores any state whose
  // orderId is not the one on screen, and POSCartScreen calls clearPersistedPaymentState() before
  // every new charge. (RC 2026-09-30: neither may touch ANOTHER order's record any more — see
  // paymentStateStorageKey.)
  try {
    if (!holdsRecoveryState(state.state)) {
      await AsyncStorage.removeItem(key);
      return;
    }
    await AsyncStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Best effort: a storage failure must never fail the payment in front of the waiter.
  }
}

async function loadPaymentState(key: string): Promise<PaymentMachineState> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) {
      return INITIAL_STATE;
    }
    return JSON.parse(raw) as PaymentMachineState;
  } catch {
    return INITIAL_STATE;
  }
}

/**
 * Clear the LEGACY single slot — call when starting a new Sale charge so a prior SUCCESS cannot
 * flash. A new sale is a new order id with no per-order record of its own, and another order's
 * in-flight or unconfirmed record is deliberately NOT touched (E4/E6 above).
 */
export async function clearPersistedPaymentState(): Promise<void> {
  await AsyncStorage.removeItem(PAYMENT_STATE_STORAGE_KEY);
}

/**
 * The record this order starts from: its own key, or -- once, from a build before per-order keys --
 * the legacy slot. A legacy record for ANOTHER order that may have taken money is moved to that
 * order's own key rather than dropped; anything else in the legacy slot is dropped.
 */
async function loadForOrder(currentOrderId?: string): Promise<PaymentMachineState> {
  if (!currentOrderId) {
    return loadPaymentState(PAYMENT_STATE_STORAGE_KEY);
  }
  const own = await loadPaymentState(paymentStateStorageKey(currentOrderId));
  const legacy = await loadPaymentState(PAYMENT_STATE_STORAGE_KEY);
  if (legacy.state === 'IDLE') {
    return own;
  }
  try {
    if (legacy.orderId && legacy.orderId !== currentOrderId && holdsRecoveryState(legacy.state)) {
      await AsyncStorage.setItem(paymentStateStorageKey(legacy.orderId), JSON.stringify(legacy));
    }
    await AsyncStorage.removeItem(PAYMENT_STATE_STORAGE_KEY);
  } catch {
    // The legacy slot stays for the next mount rather than being lost.
  }
  return own.state === 'IDLE' && legacy.orderId === currentOrderId ? legacy : own;
}

/**
 * @param currentOrderId When set, ignore persisted state for a different order so a
 * prior payment's SUCCESS cannot paint over a new Charge.
 */
export function usePaymentStateMachine(currentOrderId?: string) {
  const [machineState, dispatch] = useReducer(paymentReducer, INITIAL_STATE);
  const [isHydrated, setIsHydrated] = useState(false);
  /** The machine's state as the actions below have left it, ahead of React. See `apply`. */
  const latest = useRef<PaymentMachineState>(INITIAL_STATE);

  useEffect(() => {
    const restore = (payload: PaymentMachineState) => {
      latest.current = payload;
      dispatch({type: 'RESTORE', payload});
    };

    async function hydrate() {
      const saved = await loadForOrder(currentOrderId);
      if (saved.state === 'IDLE') {
        setIsHydrated(true);
        return;
      }

      // Stale success/fail from another order (or legacy persisted SUCCESS) must not
      // show "Payment successful" before Finatic launches. Ignored, never removed: with per-order
      // keys a mismatch is a corrupt record, and deleting it could delete another order's.
      if (
        currentOrderId &&
        saved.orderId &&
        saved.orderId !== currentOrderId
      ) {
        setIsHydrated(true);
        return;
      }

      if (saved.state === 'PAYMENT_IN_PROGRESS') {
        /**
         * #327. THIS USED TO RESTORE AS `PAYMENT_FAILED` WITH "Payment was interrupted. Please
         * retry." — the same defect as #868, on a path nobody had connected to it. An interrupted
         * payment is the textbook UNKNOWN: the app died between launching the reader and hearing
         * back, so the card may well have been charged. Calling that FAILED asserts the money did
         * not move, and "Please retry" then invites a second charge on an order that may already
         * be paid.
         */
        restore({
          ...saved,
          state: 'PAYMENT_UNCONFIRMED',
          reference: undefined,
          error: UNCONFIRMED_INTERRUPTED,
        });
      } else if (
        saved.state === 'PAYMENT_FAILED' ||
        saved.state === 'PAYMENT_UNCONFIRMED'
      ) {
        // Legacy key may still hold FAILED; only restore for this order.
        restore(saved);
      } else {
        // Drop legacy PAYMENT_SUCCESS — require a real Process Payment for this order.
        await AsyncStorage.removeItem(paymentStateStorageKey(currentOrderId));
      }
      setIsHydrated(true);
    }

    hydrate();
  }, [currentOrderId]);

  /**
   * E6 (RC sprint 2026-09-30). PERSISTED BY THE ACTION, NOT BY A RENDER EFFECT.
   *
   * A card attempt outlives its screen: the waiter can leave while the reader is open, and the
   * attempt's own code still runs to its end and calls one of these. An effect only runs while the
   * component is mounted, so an answer that arrived after Back was never written -- a later 9027
   * left no record, and a later decline could never clear one. Writing from the action makes the
   * record follow the attempt, mounted or not. `latest` runs the same reducer ahead of React, so
   * the record a later action writes carries the fields (orderId, amount) of the one before it.
   */
  const apply = useCallback(
    (action: PaymentAction) => {
      latest.current = paymentReducer(latest.current, action);
      persistPaymentState(latest.current, currentOrderId);
      dispatch(action);
    },
    [currentOrderId],
  );

  const startPayment = useCallback(
    (orderId: string, amount: number) => {
      apply({type: 'START_PAYMENT', orderId, amount});
    },
    [apply],
  );

  const paymentSuccess = useCallback(
    (reference: string) => {
      apply({type: 'PAYMENT_SUCCESS', reference});
    },
    [apply],
  );

  const paymentFailed = useCallback(
    (error: string) => {
      apply({type: 'PAYMENT_FAILED', error});
    },
    [apply],
  );

  /** #327. `detail` must be one complete sentence, not a fragment to glue onto another. */
  const paymentUnconfirmed = useCallback(
    (detail?: string) => {
      apply({type: 'PAYMENT_UNCONFIRMED', detail});
    },
    [apply],
  );

  const reset = useCallback(() => {
    apply({type: 'RESET'});
  }, [apply]);

  return {
    machineState,
    isHydrated,
    startPayment,
    paymentSuccess,
    paymentFailed,
    paymentUnconfirmed,
    reset,
  };
}

interface PaymentStateMachineProps {
  state: PaymentState;
  reference?: string;
  error?: string;
}

const STATE_LABELS: Record<PaymentState, string> = {
  IDLE: 'Ready to pay',
  PAYMENT_IN_PROGRESS: 'Processing payment…',
  PAYMENT_SUCCESS: 'Payment successful',
  PAYMENT_FAILED: 'Payment failed',
  PAYMENT_UNCONFIRMED: UNCONFIRMED_TITLE,
};

const STATE_COLORS: Record<PaymentState, string> = {
  IDLE: '#6B7280',
  PAYMENT_IN_PROGRESS: '#2563EB',
  PAYMENT_SUCCESS: '#059669',
  PAYMENT_FAILED: '#DC2626',
  // Amber, deliberately neither the green nor the red. An operator reading the colour alone must
  // not be able to sort this into "done" or "declined" — those are the two answers it is not.
  PAYMENT_UNCONFIRMED: '#D97706',
};

export default function PaymentStateMachine({
  state,
  reference,
  error,
}: PaymentStateMachineProps) {
  return (
    <View style={styles.container}>
      <View style={[styles.indicator, {backgroundColor: STATE_COLORS[state]}]} />
      <Text style={[styles.label, {color: STATE_COLORS[state]}]}>
        {STATE_LABELS[state]}
      </Text>
      {reference ? (
        <Text style={styles.reference}>Reference: {reference}</Text>
      ) : null}
      {error ? <Text style={styles.message}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: 16,
  },
  indicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginBottom: 8,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
  reference: {
    fontSize: 14,
    color: '#059669',
    marginTop: 8,
    fontWeight: '500',
  },
  message: {
    fontSize: 14,
    color: '#DC2626',
    marginTop: 4,
    textAlign: 'center',
  },
});
