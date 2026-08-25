import EncryptedStorage from 'react-native-encrypted-storage';
import {
  MERCHANT_NO_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
  RESTAURANT_ID_STORAGE_KEY,
  RESTAURANT_NAME_STORAGE_KEY,
  STORE_NO_STORAGE_KEY,
  TERMINAL_ID_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  HELD_ORPHAN_PAYMENT_STORAGE_KEY,
} from '../constants';

export async function saveTerminalToken(token: string): Promise<void> {
  await EncryptedStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export async function getTerminalToken(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function clearTerminalToken(): Promise<void> {
  try {
    await EncryptedStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Item may not exist
  }
}

export async function saveRefreshToken(token: string): Promise<void> {
  await EncryptedStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
}

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function clearRefreshToken(): Promise<void> {
  try {
    await EncryptedStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  } catch {
    // Item may not exist
  }
}

export async function clearAllTokens(): Promise<void> {
  await Promise.all([clearTerminalToken(), clearRefreshToken()]);
}

export async function saveRestaurantId(id: string): Promise<void> {
  await EncryptedStorage.setItem(RESTAURANT_ID_STORAGE_KEY, id);
}

export async function getRestaurantId(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(RESTAURANT_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function saveTerminalId(id: string): Promise<void> {
  await EncryptedStorage.setItem(TERMINAL_ID_STORAGE_KEY, id);
}

export async function getTerminalId(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(TERMINAL_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function saveRestaurantName(name: string): Promise<void> {
  await EncryptedStorage.setItem(RESTAURANT_NAME_STORAGE_KEY, name);
}

export async function getRestaurantName(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(RESTAURANT_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function saveMerchantCredentials(
  merchantNo: string,
  storeNo: string,
): Promise<void> {
  await EncryptedStorage.setItem(MERCHANT_NO_STORAGE_KEY, merchantNo);
  await EncryptedStorage.setItem(STORE_NO_STORAGE_KEY, storeNo);
}

export async function getMerchantCredentials(): Promise<{
  merchantNo: string;
  storeNo: string;
} | null> {
  try {
    const [merchantNo, storeNo] = await Promise.all([
      EncryptedStorage.getItem(MERCHANT_NO_STORAGE_KEY),
      EncryptedStorage.getItem(STORE_NO_STORAGE_KEY),
    ]);
    if (!merchantNo || !storeNo) {
      return null;
    }
    return {merchantNo, storeNo};
  } catch {
    return null;
  }
}

export async function clearTerminalSession(): Promise<void> {
  const keys = [
    TOKEN_STORAGE_KEY,
    REFRESH_TOKEN_STORAGE_KEY,
    RESTAURANT_ID_STORAGE_KEY,
    TERMINAL_ID_STORAGE_KEY,
    RESTAURANT_NAME_STORAGE_KEY,
  ];

  await Promise.all(
    keys.map(async key => {
      try {
        await EncryptedStorage.removeItem(key);
      } catch {
        // Item may not exist
      }
    }),
  );
}

export async function clearAllData(): Promise<void> {
  const keys = [
    TOKEN_STORAGE_KEY,
    REFRESH_TOKEN_STORAGE_KEY,
    RESTAURANT_ID_STORAGE_KEY,
    TERMINAL_ID_STORAGE_KEY,
    RESTAURANT_NAME_STORAGE_KEY,
    MERCHANT_NO_STORAGE_KEY,
    STORE_NO_STORAGE_KEY,
  ];
  await Promise.all(
    keys.map(key =>
      EncryptedStorage.removeItem(key).catch(() => {}),
    ),
  );
  const {clearReceiptPrintSettings} = await import('./receiptPrintSettings');
  await clearReceiptPrintSettings();
}

// ─── #344: a recovered orphan that could not be applied ───────────────────

/**
 * A card payment the device recovered after process death, which did NOT belong to the order on
 * screen (or whose order could not be established), held until someone checks it.
 *
 * WHY IT IS PERSISTED AT ALL. `PaymentModule.consumeOrphanedPaymentResult` is DESTRUCTIVE — it
 * removes the record from SharedPreferences before resolving. So the moment JS decides not to
 * apply an orphan, that transaction exists nowhere else. Holding it here is what turns "do not
 * apply" into something other than "discard", which the ruling is explicit about: a card
 * transaction is not dropped because the screen moved on.
 *
 * WHY ENCRYPTED STORAGE RATHER THAN A NATIVE RE-PERSIST. Re-persisting on the native side would
 * need a new @ReactMethod and therefore Kotlin plus an APK, and would put the record back in the
 * same store the next consume drains. This keeps it in the store the terminal already uses for
 * credentials, survives the app being killed, and needs no native change.
 *
 * THE RESIDUAL WINDOW, stated rather than hidden: native clears its copy before JS receives it, so
 * a process death BETWEEN the consume and this write still loses the orphan. That window is
 * milliseconds and it is strictly smaller than today's behaviour, where the orphan is not lost but
 * is silently applied to the wrong order. Closing it entirely needs a non-destructive native read
 * plus an explicit acknowledge — noted for the owner, not done here.
 */
export type HeldOrphanPayment = {
  /** The order the payment was launched for, as native recorded it. '' when unknown. */
  orphanOrderId: string;
  /** The order that was on screen when it surfaced — what it was NOT applied to. */
  seenWhileChargingOrderId: string;
  reason: 'different_order' | 'unknown_order';
  voucherNo?: string;
  businessOrderNo?: string;
  /** ISO timestamp of when it was held, so staff can tell one from another. */
  heldAt: string;
};

export async function holdOrphanPayment(
  record: HeldOrphanPayment,
): Promise<void> {
  // Best effort by design: failing to persist must never break the payment in progress. The
  // alternative is throwing inside a recovery path and losing the CURRENT sale as well.
  try {
    const existing = await getHeldOrphanPayments();
    // Appended, never overwritten — two stranded transactions are two facts, not one.
    await EncryptedStorage.setItem(
      HELD_ORPHAN_PAYMENT_STORAGE_KEY,
      JSON.stringify([...existing, record]),
    );
  } catch (err) {
    console.warn('[storage] failed to hold orphaned payment', err);
  }
}

export async function getHeldOrphanPayments(): Promise<HeldOrphanPayment[]> {
  try {
    const raw = await EncryptedStorage.getItem(HELD_ORPHAN_PAYMENT_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HeldOrphanPayment[]) : [];
  } catch {
    return [];
  }
}

/**
 * Clear the held record(s). This is an OPERATOR action — "I have checked this" — never something
 * the app decides on its own, because the record is the only trace the transaction ever existed.
 */
export async function clearHeldOrphanPayments(): Promise<void> {
  try {
    await EncryptedStorage.removeItem(HELD_ORPHAN_PAYMENT_STORAGE_KEY);
  } catch (err) {
    console.warn('[storage] failed to clear held orphaned payments', err);
  }
}

/**
 * Write the held list back after a reporting pass (#344). Used to drop records the server has
 * acknowledged while keeping the rest — never to clear the lot, which is what
 * clearHeldOrphanPayments is for and which is an operator action, not an automatic one.
 */
export async function setHeldOrphanPayments(
  rows: HeldOrphanPayment[],
): Promise<void> {
  try {
    if (rows.length === 0) {
      await EncryptedStorage.removeItem(HELD_ORPHAN_PAYMENT_STORAGE_KEY);
      return;
    }
    await EncryptedStorage.setItem(
      HELD_ORPHAN_PAYMENT_STORAGE_KEY,
      JSON.stringify(rows),
    );
  } catch (err) {
    console.warn('[storage] failed to write held orphaned payments', err);
  }
}
