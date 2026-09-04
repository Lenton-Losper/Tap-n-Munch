import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  WALKOUT_CONFIRM,
  WALKOUT_NO_MANAGERS,
  WALKOUT_OFFER_BODY,
  WALKOUT_OFFER_TITLE,
  WALKOUT_PICK_MANAGER,
  WALKOUT_PIN_PROMPT,
  WALKOUT_REASON_PROMPT,
  WALKOUT_REFUSED_PIN,
} from '../constants/closeTableCopy';
import {
  ApiRequestError,
  authorizeTerminalAction,
  getAuthorizedUsers,
  walkoutCloseTable,
  type AuthorizedUser,
} from '../lib/api';
import {getTerminalToken} from '../lib/storage';

/**
 * THE MANAGER OVERRIDE, INSIDE THE REFUSAL DIALOG.
 *
 * ============================================================================================
 * WHY IT LIVES HERE AND NOT ON ITS OWN SCREEN
 * ============================================================================================
 *
 * A walkout happens with the waiter at the table and a manager beside them, in a room that is
 * watching. Sending the waiter to another screen to find the override is how a walkout becomes an
 * unclosed table for the rest of the shift.
 *
 * ============================================================================================
 * OFFERED ONLY WHEN MONEY IS THE ONLY BLOCKER
 * ============================================================================================
 *
 * The caller gates this on walkoutOverrideAvailable(). "Still being made" is something a waiter
 * fixes by waiting or voiding, and an override reachable from an ordinary blocker stops being a
 * control within a week because staff learn it is the fast path.
 *
 * ============================================================================================
 * THE AMOUNT IS SHOWN BEFORE THE PIN IS ASKED FOR
 * ============================================================================================
 *
 * A manager authorising a write-off should see the number while deciding, not after. That is why
 * WALKOUT_OFFER_BODY carries {amount} and why it renders above the picker.
 *
 * NOTHING HERE MARKS ANYTHING PAID. The route it calls writes no paid_at, no payment_status and no
 * payment_events row -- the tab closes and the orders stay honestly unpaid, so the loss is visible
 * in every report rather than absorbed. Before 2026-07-30 a close bulk-stamped paid_at and left
 * three production orders marked paid with no payment behind them.
 */
export default function WalkoutOverride({
  tableId,
  amountOwed,
  onClosed,
}: {
  tableId: string;
  /**
   * The server's `unpaid_total`, or null when that figure is absent or unreadable. NEVER a client
   * sum -- see lib/tabSettlement.amountOwed, which is where this comes from.
   */
  amountOwed: number | null;
  onClosed: () => void;
}) {
  const [managers, setManagers] = useState<AuthorizedUser[] | null>(null);
  const [selected, setSelected] = useState<AuthorizedUser | null>(null);
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getTerminalToken();
        if (!token) {
          return;
        }
        const users = await getAuthorizedUsers('walkout_close', token);
        if (!cancelled) {
          setManagers(users);
        }
      } catch {
        // An empty list and a failed read look the same to a waiter, so both render the same
        // guidance. Distinguishing them would need wording nobody has signed.
        if (!cancelled) {
          setManagers([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = useCallback(async () => {
    if (!selected || pin.trim().length === 0 || reason.trim().length < 3) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setError(WALKOUT_REFUSED_PIN);
        return;
      }

      /**
       * TWO STEPS, AND THE ORDER MATTERS. The PIN mints a single-use token for purpose
       * 'walkout_close', and the close spends it. The permission is checked at BOTH ends since
       * 2026-09-04 -- mint and consume -- because one enforcement point is one bug away from none.
       */
      const auth = await authorizeTerminalAction(
        selected.user_id,
        pin.trim(),
        'walkout_close',
        token,
      );

      await walkoutCloseTable(tableId, {
        reason: reason.trim(),
        staffUserId: selected.user_id,
        authorizationTokenId: auth.token_id,
      }, token);

      onClosed();
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : null;
      // A wrong PIN and a PIN belonging to someone without the permission are different facts,
      // but both mean "this person cannot authorise it here", which is what the waiter must act on.
      setError(
        code === 'AUTHORIZATION_INVALID' || code === 'AUTHORIZATION_REQUIRED'
          ? WALKOUT_REFUSED_PIN
          : err instanceof Error
            ? err.message
            : WALKOUT_REFUSED_PIN,
      );
      setPin('');
    } finally {
      setBusy(false);
    }
  }, [selected, pin, reason, tableId, onClosed]);

  if (managers === null) {
    return (
      <View style={styles.block} testID="walkout-loading">
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  if (managers.length === 0) {
    return (
      <View style={styles.block} testID="walkout-no-managers">
        <Text style={styles.noManagers}>{WALKOUT_NO_MANAGERS}</Text>
      </View>
    );
  }

  const ready = selected != null && pin.trim().length > 0 && reason.trim().length >= 3;

  return (
    <View style={styles.block} testID="walkout-override">
      <Text style={styles.offerTitle}>{WALKOUT_OFFER_TITLE}</Text>
      <Text style={styles.offerBody}>
        {offerBody(amountOwed)}
      </Text>

      <Text style={styles.label}>{WALKOUT_PICK_MANAGER}</Text>
      <View style={styles.managerRow}>
        {managers.map(m => (
          <Pressable
            key={m.user_id}
            testID={`walkout-manager-${m.user_id}`}
            style={[styles.managerChip, selected?.user_id === m.user_id && styles.managerChipOn]}
            onPress={() => {
              setSelected(m);
              setPin('');
              setError(null);
            }}>
            <Text
              style={[
                styles.managerChipText,
                selected?.user_id === m.user_id && styles.managerChipTextOn,
              ]}>
              {m.name}
            </Text>
          </Pressable>
        ))}
      </View>

      {selected ? (
        <>
          <TextInput
            testID="walkout-pin"
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            placeholder={WALKOUT_PIN_PROMPT.replace('{name}', selected.name)}
            placeholderTextColor={Colors.textMuted}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={12}
          />
          <TextInput
            testID="walkout-reason"
            style={styles.input}
            value={reason}
            onChangeText={setReason}
            placeholder={WALKOUT_REASON_PROMPT}
            placeholderTextColor={Colors.textMuted}
            maxLength={200}
          />
        </>
      ) : null}

      {error ? (
        <Text style={styles.error} testID="walkout-error">
          {error}
        </Text>
      ) : null}

      <Pressable
        testID="walkout-confirm"
        disabled={!ready || busy}
        onPress={confirm}
        style={[styles.confirm, (!ready || busy) && styles.confirmDisabled]}>
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.confirmText}>{WALKOUT_CONFIRM}</Text>
        )}
      </Pressable>
    </View>
  );
}

function formatNad(amount: number): string {
  return `N$${amount.toFixed(2)}`;
}

/**
 * The signed body, and what happens when there is no figure to put in it.
 *
 * WALKOUT_OFFER_BODY is two sentences: "A manager can close this table." and "{amount} will be
 * recorded as unpaid." The second is a CLAIM ABOUT A NUMBER. When the server's unpaid_total is
 * absent or unreadable -- which is possible here, since ORDER_OWES_MONEY and
 * LINE_TRACKING_UNAVAILABLE both refuse without it -- that sentence is dropped rather than filled
 * with a zero. N$0.00 would read as "nothing is owed" to the manager being asked to authorise the
 * write-off, which is the opposite of the truth.
 *
 * Dropping the sentence is not new copy: what renders is a prefix of the signed string. Nothing
 * unsigned is ever shown.
 */
export function offerBody(amount: number | null): string {
  if (amount != null && Number.isFinite(amount) && amount > 0) {
    return WALKOUT_OFFER_BODY.replace('{amount}', formatNad(amount));
  }
  return WALKOUT_OFFER_BODY.slice(0, WALKOUT_OFFER_BODY.indexOf('{amount}')).trim();
}

const styles = StyleSheet.create({
  block: {
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: Spacing.sm,
  },
  offerTitle: {...Typography.subheading, color: Colors.textPrimary},
  offerBody: {...Typography.small, color: Colors.textSecondary},
  label: {...Typography.small, color: Colors.textSecondary, marginTop: Spacing.xs},
  managerRow: {flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs},
  managerChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#F3F4F6',
  },
  managerChipOn: {backgroundColor: Colors.primary},
  managerChipText: {...Typography.small, color: Colors.textPrimary},
  managerChipTextOn: {color: '#FFFFFF', fontWeight: '700'},
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    ...Typography.body,
    color: Colors.textPrimary,
  },
  error: {...Typography.small, color: Colors.red},
  noManagers: {...Typography.small, color: Colors.textSecondary},
  confirm: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  confirmDisabled: {opacity: 0.4},
  confirmText: {...Typography.body, color: '#FFFFFF', fontWeight: '800'},
});
