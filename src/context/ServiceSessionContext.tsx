import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import {
  addLine,
  adjustLineQuantity,
  newRoundIdempotencyKey,
  removeLine,
  RoundLine,
  setLineNote,
  splitLine,
} from '../lib/serviceRound';

/**
 * The waiter the device is holding, and the tab it is holding them against.
 *
 * THIS IS THE ONLY PLACE A "WAITER SESSION" EXISTS ANYWHERE IN THE SYSTEM. The server holds none:
 * there is no logout endpoint and none is needed, because the PIN token was single-use and was
 * already consumed when the table was opened. Everything between opening a table and sending a
 * round is device-side memory, and dropping it is therefore purely a client act.
 */
export interface ServiceWaiter {
  userId: string;
  name: string;
}

export interface ServiceTable {
  tableId: string;
  tableNumber: number;
  tableName: string | null;
  tabId: string;
  /** Whose table this is, per the server. May be null on a legitimately unowned open tab. */
  ownerName: string | null;
}

interface ServiceSessionValue {
  waiter: ServiceWaiter | null;
  table: ServiceTable | null;
  lines: RoundLine[];
  /**
   * The `x-idempotency-key` for the round currently being built. Non-null whenever the basket has
   * lines, so the send path can always supply one, and STABLE across retries of that same round.
   */
  idempotencyKey: string | null;
  orderInstructions: string;
  beginSession: (waiter: ServiceWaiter | null, table: ServiceTable) => void;
  addItem: (item: {id: string; name: string; base_price: number}) => void;
  adjustQuantity: (lineId: string, delta: number) => void;
  removeItem: (lineId: string) => void;
  setNote: (lineId: string, note: string) => void;
  splitOne: (lineId: string) => void;
  setOrderInstructions: (text: string) => void;
  /** Empties the basket and retires the idempotency key, keeping the waiter and table. */
  clearBasket: () => void;
  /** Drops EVERYTHING — waiter, table, basket, key. See the docblock on the provider. */
  endSession: () => void;
}

const ServiceSessionContext = createContext<ServiceSessionValue | undefined>(
  undefined,
);

/**
 * Holds one waiter's work between opening a table and sending a round, and nothing longer.
 *
 * THE SEND-DROPS-THE-SESSION RULE lives with the caller, not here, but this is what it acts on:
 * on any 2xx from POST /rounds the screen calls endSession(), and the next action on the device —
 * opening another table — needs a PIN again. The same call is made on Back out of the round
 * screen and on cancel, because a waiter walking away from a half-built round must not leave their
 * identity sitting on the device for whoever picks it up next.
 *
 * Attribution does not depend on any of this. The round is credited to whoever opened the TAB,
 * server-side, so dropping the session is about the NEXT table, never about the round just sent.
 *
 * Deliberately NOT persisted. Nothing about a waiter should survive an app restart.
 */
export function ServiceSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [waiter, setWaiter] = useState<ServiceWaiter | null>(null);
  const [table, setTable] = useState<ServiceTable | null>(null);
  const [lines, setLines] = useState<RoundLine[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [orderInstructions, setOrderInstructionsState] = useState('');

  const beginSession = useCallback(
    (nextWaiter: ServiceWaiter | null, nextTable: ServiceTable) => {
      setWaiter(nextWaiter);
      setTable(nextTable);
      setLines([]);
      setIdempotencyKey(null);
      setOrderInstructionsState('');
    },
    [],
  );

  const addItem = useCallback(
    (item: {id: string; name: string; base_price: number}) => {
      // Ringing up the first item starts the round, and with it the key. `?? prev` keeps it stable
      // for every subsequent item and for every retry of this round — a 500 is explicitly
      // retryable with the SAME key, and a new key on retry is how a round gets billed twice.
      setIdempotencyKey(prev => prev ?? newRoundIdempotencyKey());
      setLines(prev => addLine(prev, item));
    },
    [],
  );

  const adjustQuantity = useCallback((lineId: string, delta: number) => {
    setLines(prev => adjustLineQuantity(prev, lineId, delta));
  }, []);

  const removeItem = useCallback((lineId: string) => {
    setLines(prev => removeLine(prev, lineId));
  }, []);

  const setNote = useCallback((lineId: string, note: string) => {
    setLines(prev => setLineNote(prev, lineId, note));
  }, []);

  const splitOne = useCallback((lineId: string) => {
    setLines(prev => splitLine(prev, lineId));
  }, []);

  const setOrderInstructions = useCallback((text: string) => {
    setOrderInstructionsState(text);
  }, []);

  const clearBasket = useCallback(() => {
    setLines([]);
    setIdempotencyKey(null);
    setOrderInstructionsState('');
  }, []);

  const endSession = useCallback(() => {
    setWaiter(null);
    setTable(null);
    setLines([]);
    setIdempotencyKey(null);
    setOrderInstructionsState('');
  }, []);

  const value = useMemo(
    () => ({
      waiter,
      table,
      lines,
      idempotencyKey,
      orderInstructions,
      beginSession,
      addItem,
      adjustQuantity,
      removeItem,
      setNote,
      splitOne,
      setOrderInstructions,
      clearBasket,
      endSession,
    }),
    [
      waiter,
      table,
      lines,
      idempotencyKey,
      orderInstructions,
      beginSession,
      addItem,
      adjustQuantity,
      removeItem,
      setNote,
      splitOne,
      setOrderInstructions,
      clearBasket,
      endSession,
    ],
  );

  return (
    <ServiceSessionContext.Provider value={value}>
      {children}
    </ServiceSessionContext.Provider>
  );
}

export function useServiceSession(): ServiceSessionValue {
  const ctx = useContext(ServiceSessionContext);
  if (!ctx) {
    throw new Error(
      'useServiceSession must be used within a ServiceSessionProvider',
    );
  }
  return ctx;
}
