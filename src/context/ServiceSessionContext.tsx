import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  addLine,
  adjustLineQuantity,
  newRoundIdempotencyKey,
  removeLine,
  RoundLine,
  setLineNote,
  clampLineQuantity,
} from '../lib/serviceRound';
import type {VariantPricedItem, VariantSelection} from '../lib/variantPricing';

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
  /**
   * NON-NULL WHILE A SENT ROUND'S OUTCOME IS UNKNOWN. (Sprint 2026-09-28 brief, Riviera #160.)
   *
   * A timeout, a dropped connection or a 5xx leaves the round possibly ON THE TAB under
   * `idempotencyKey`. If the basket could still be edited, the next Send would carry a DIFFERENT
   * basket under the SAME key: the server replays the ORIGINAL round, and the waiter is shown the
   * edited one as sent. That is how a removed Modena Pasta was cooked.
   *
   * So while this is set, every basket edit below is a no-op and the key cannot rotate. It is
   * released only by a definite answer — see ServiceRoundReviewScreen.
   */
  roundLock: RoundLock | null;
  /** Freeze the basket and key. Called by the send path on an unknown outcome, nowhere else. */
  lockRound: (lock: RoundLock) => void;
  /** Release it. Called only once the server has given a definite answer about the round. */
  unlockRound: () => void;
  beginSession: (waiter: ServiceWaiter | null, table: ServiceTable) => void;
  addItem: (
    item: VariantPricedItem,
    options?: {quantity?: number; note?: string; selectedVariants?: VariantSelection},
  ) => void;
  adjustQuantity: (lineId: string, delta: number) => void;
  removeItem: (lineId: string) => void;
  setNote: (lineId: string, note: string) => void;
  updateLine: (lineId: string, next: {quantity: number; note: string}) => void;
  setOrderInstructions: (text: string) => void;
  /** Empties the basket and retires the idempotency key, keeping the waiter and table. */
  clearBasket: () => void;
  /** Drops EVERYTHING — waiter, table, basket, key. See the docblock on the provider. */
  endSession: () => void;
}

export interface RoundLock {
  /** Why the outcome is unknown: no answer in time, no connection, or a server failure. */
  kind: 'timeout' | 'network' | 'server';
  /** When the FIRST attempt of this round was sent, device clock. Used only to narrow a search. */
  sentAt: number;
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
  const [roundLock, setRoundLock] = useState<RoundLock | null>(null);
  /**
   * The lock, readable synchronously. The edit callbacks are stable (empty deps) and a press can
   * land in the same frame as the lock, so they consult this ref rather than render state.
   */
  const lockRef = useRef<RoundLock | null>(null);
  const locked = () => lockRef.current != null;

  const lockRound = useCallback((lock: RoundLock) => {
    lockRef.current = lock;
    setRoundLock(lock);
  }, []);

  const unlockRound = useCallback(() => {
    lockRef.current = null;
    setRoundLock(null);
  }, []);

  /**
   * beginSession and endSession are NOT gated by the lock: they are leaving the round, not editing
   * it, and a device must never be stuck unable to open another table. The review screen blocks
   * leaving while the round is locked; these clear the lock with everything else.
   */
  const beginSession = useCallback(
    (nextWaiter: ServiceWaiter | null, nextTable: ServiceTable) => {
      lockRef.current = null;
      setRoundLock(null);
      setWaiter(nextWaiter);
      setTable(nextTable);
      setLines([]);
      setIdempotencyKey(null);
      setOrderInstructionsState('');
    },
    [],
  );

  const addItem = useCallback(
    (
      item: VariantPricedItem,
      options?: {quantity?: number; note?: string; selectedVariants?: VariantSelection},
    ) => {
      if (locked()) {
        return;
      }
      // Ringing up the first item starts the round, and with it the key. `?? prev` keeps it stable
      // for every subsequent item and for every retry of this round — a 500 is explicitly
      // retryable with the SAME key, and a new key on retry is how a round gets billed twice.
      setIdempotencyKey(prev => prev ?? newRoundIdempotencyKey());
      setLines(prev => addLine(prev, item, options));
    },
    [],
  );

  const adjustQuantity = useCallback((lineId: string, delta: number) => {
    if (locked()) {
      return;
    }
    setLines(prev => adjustLineQuantity(prev, lineId, delta));
  }, []);

  const removeItem = useCallback((lineId: string) => {
    if (locked()) {
      return;
    }
    setLines(prev => removeLine(prev, lineId));
  }, []);

  const setNote = useCallback((lineId: string, note: string) => {
    if (locked()) {
      return;
    }
    setLines(prev => setLineNote(prev, lineId, note));
  }, []);

  /**
   * Applies a sheet edit to an existing line. Replaces splitOne: peeling a unit off existed so a
   * note could apply to some units and not others, and the sheet makes that two separate adds.
   */
  const updateLine = useCallback(
    (lineId: string, next: {quantity: number; note: string}) => {
      if (locked()) {
        return;
      }
      setLines(prev =>
        prev
          .map(line =>
            line.lineId === lineId
              ? {...line, quantity: clampLineQuantity(next.quantity), note: next.note.trim()}
              : line,
          )
          .filter(line => line.quantity > 0),
      );
    },
    [],
  );

  const setOrderInstructions = useCallback((text: string) => {
    // The order note is part of the request body too; editing it under a sent key is the same
    // defect as editing an item.
    if (locked()) {
      return;
    }
    setOrderInstructionsState(text);
  }, []);

  /**
   * Refused while locked. Emptying the basket retires the key — exactly the silent rotation the
   * lock exists to prevent. The send path unlocks FIRST when it has a definite answer.
   */
  const clearBasket = useCallback(() => {
    if (locked()) {
      return;
    }
    setLines([]);
    setIdempotencyKey(null);
    setOrderInstructionsState('');
  }, []);

  const endSession = useCallback(() => {
    lockRef.current = null;
    setRoundLock(null);
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
      roundLock,
      lockRound,
      unlockRound,
      beginSession,
      addItem,
      adjustQuantity,
      removeItem,
      setNote,
      updateLine,
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
      roundLock,
      lockRound,
      unlockRound,
      beginSession,
      addItem,
      adjustQuantity,
      removeItem,
      setNote,
      updateLine,
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
