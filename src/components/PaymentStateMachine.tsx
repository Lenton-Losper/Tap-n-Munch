import React, {useCallback, useEffect, useReducer, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {StyleSheet, Text, View} from 'react-native';
import {PAYMENT_STATE_STORAGE_KEY} from '../constants';
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
    case 'RESET':
      return INITIAL_STATE;
    case 'RESTORE':
      return action.payload;
    default:
      return state;
  }
}

async function persistPaymentState(state: PaymentMachineState): Promise<void> {
  if (state.state === 'IDLE') {
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

export function usePaymentStateMachine() {
  const [machineState, dispatch] = useReducer(paymentReducer, INITIAL_STATE);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    async function hydrate() {
      const saved = await loadPaymentState();
      if (saved.state !== 'IDLE') {
        if (saved.state === 'PAYMENT_IN_PROGRESS') {
          dispatch({
            type: 'RESTORE',
            payload: {
              ...saved,
              state: 'PAYMENT_FAILED',
              error: 'Payment was interrupted. Please retry.',
            },
          });
        } else {
          dispatch({type: 'RESTORE', payload: saved});
        }
      }
      setIsHydrated(true);
    }

    hydrate();
  }, []);

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

  const reset = useCallback(() => {
    dispatch({type: 'RESET'});
  }, []);

  return {
    machineState,
    startPayment,
    paymentSuccess,
    paymentFailed,
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
};

const STATE_COLORS: Record<PaymentState, string> = {
  IDLE: '#6B7280',
  PAYMENT_IN_PROGRESS: '#2563EB',
  PAYMENT_SUCCESS: '#059669',
  PAYMENT_FAILED: '#DC2626',
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
