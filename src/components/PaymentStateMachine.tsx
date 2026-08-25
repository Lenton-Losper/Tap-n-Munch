import React, {useCallback, useEffect, useReducer, useState} from 'react';
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

async function persistPaymentState(state: PaymentMachineState): Promise<void> {
  // Only crash-recover in-flight payments. Never persist SUCCESS/FAILED — otherwise
  // Sale → Charge for a new order hydrates a prior success and skips Finatic.
  //
  // PAYMENT_UNCONFIRMED IS THE ONE TERMINAL STATE WORTH PERSISTING (#327). Losing it on a restart
  // loses the only thing standing between an unconfirmed payment and released food, and the
  // reasons the other two are not persisted do not apply to it: a stale SUCCESS is dangerous
  // because it claims money arrived, and a stale FAILED is noise, but a stale UNCONFIRMED merely
  // repeats "check this before releasing", which is never the wrong instruction. The two guards
  // that already contain a stale payload cover it unchanged — hydrate() drops any state whose
  // orderId is not the one on screen, and POSCartScreen calls clearPersistedPaymentState() before
  // every new charge.
  if (
    state.state !== 'PAYMENT_IN_PROGRESS' &&
    state.state !== 'PAYMENT_UNCONFIRMED'
  ) {
    await AsyncStorage.removeItem(PAYMENT_STATE_STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(PAYMENT_STATE_STORAGE_KEY, JSON.stringify(state));
}

async function loadPaymentState(): Promise<PaymentMachineState> {
  try {
    const raw = await AsyncStorage.getItem(PAYMENT_STATE_STORAGE_KEY);
    if (!raw) {
      return INITIAL_STATE;
    }
    return JSON.parse(raw) as PaymentMachineState;
  } catch {
    return INITIAL_STATE;
  }
}

/** Clear crash-recovery key — call when starting a new Sale charge so a prior SUCCESS cannot flash. */
export async function clearPersistedPaymentState(): Promise<void> {
  await AsyncStorage.removeItem(PAYMENT_STATE_STORAGE_KEY);
}

/**
 * @param currentOrderId When set, ignore persisted state for a different order so a
 * prior payment's SUCCESS cannot paint over a new Charge.
 */
export function usePaymentStateMachine(currentOrderId?: string) {
  const [machineState, dispatch] = useReducer(paymentReducer, INITIAL_STATE);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    async function hydrate() {
      const saved = await loadPaymentState();
      if (saved.state === 'IDLE') {
        setIsHydrated(true);
        return;
      }

      // Stale success/fail from another order (or legacy persisted SUCCESS) must not
      // show "Payment successful" before Finatic launches.
      if (
        currentOrderId &&
        saved.orderId &&
        saved.orderId !== currentOrderId
      ) {
        await AsyncStorage.removeItem(PAYMENT_STATE_STORAGE_KEY);
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
        dispatch({
          type: 'RESTORE',
          payload: {
            ...saved,
            state: 'PAYMENT_UNCONFIRMED',
            reference: undefined,
            error: UNCONFIRMED_INTERRUPTED,
          },
        });
      } else if (
        saved.state === 'PAYMENT_FAILED' ||
        saved.state === 'PAYMENT_UNCONFIRMED'
      ) {
        // Legacy key may still hold FAILED; only restore for this order.
        dispatch({type: 'RESTORE', payload: saved});
      } else {
        // Drop legacy PAYMENT_SUCCESS — require a real Process Payment for this order.
        await AsyncStorage.removeItem(PAYMENT_STATE_STORAGE_KEY);
      }
      setIsHydrated(true);
    }

    hydrate();
  }, [currentOrderId]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    persistPaymentState(machineState);
  }, [machineState, isHydrated]);

  const startPayment = useCallback((orderId: string, amount: number) => {
    dispatch({type: 'START_PAYMENT', orderId, amount});
  }, []);

  const paymentSuccess = useCallback((reference: string) => {
    dispatch({type: 'PAYMENT_SUCCESS', reference});
  }, []);

  const paymentFailed = useCallback((error: string) => {
    dispatch({type: 'PAYMENT_FAILED', error});
  }, []);

  /** #327. `detail` must be one complete sentence, not a fragment to glue onto another. */
  const paymentUnconfirmed = useCallback((detail?: string) => {
    dispatch({type: 'PAYMENT_UNCONFIRMED', detail});
  }, []);

  const reset = useCallback(() => {
    dispatch({type: 'RESET'});
  }, []);

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
