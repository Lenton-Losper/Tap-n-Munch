/**
 * THE CASH-UP SCREEN.
 *
 * ================================================================================================
 * ONE PRESS DOES EVERYTHING, AND THAT IS DELIBERATE
 * ================================================================================================
 *
 * Pick a period, pick who is printing, type their PIN, press once. The PIN is exchanged for a
 * single-use token, the report is fetched with it, and the paper comes out — all inside the one
 * press, exactly as the gratuity and the void approval work.
 *
 * A separate "Authorise" tap would mint a short-lived token that then expires while somebody counts
 * a drawer, and would leave a state where a manager has approved and no paper exists — which reads
 * to everyone standing there as done.
 *
 * ================================================================================================
 * THREE PERIODS. NO PICKER.
 * ================================================================================================
 *
 * Today, Yesterday, This week. A hand-rolled touchscreen date picker for a P5 is disproportionate
 * to the ask, and "today" is what a cash-up is for. The screen SAYS where a longer period comes
 * from, so a manager who wants last month knows the feature is elsewhere rather than broken.
 * Owner's ruling, 2026-09-07.
 *
 * THE SERVER KEEPS ITS OWN ALLOW-LIST of the same three. Adding a fourth button here would be
 * refused with INVALID_PRESET rather than served.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/cashUpCopy';
import {
  ApiRequestError,
  authorizeTerminalAction,
  getAuthorizedUsers,
  type AuthorizedUser,
  type CashUpPreset,
} from '../lib/api';
import {printCashUp} from '../lib/cashUpPrinting';
import {cashUpFailureMessage, cashUpReady, type CashUpDraft} from '../lib/cashUp';
import {getTerminalToken} from '../lib/storage';

const PERIODS: Array<{id: CashUpPreset; label: string}> = [
  {id: 'today', label: Copy.CASH_UP_PERIOD_TODAY},
  {id: 'yesterday', label: Copy.CASH_UP_PERIOD_YESTERDAY},
  {id: 'thisWeek', label: Copy.CASH_UP_PERIOD_THIS_WEEK},
];

export default function CashUpScreen() {
  const [preset, setPreset] = useState<CashUpPreset>('today');
  const [managers, setManagers] = useState<AuthorizedUser[] | null>(null);
  const [draft, setDraft] = useState<CashUpDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getTerminalToken();
        if (!token) {
          if (!cancelled) setManagers([]);
          return;
        }
        const users = await getAuthorizedUsers('cash_up', token);
        if (!cancelled) setManagers(users);
      } catch {
        // An empty list and a failed read mean the same thing to the person holding the terminal:
        // nobody here can print it right now. Distinguishing them needs wording nobody has signed.
        if (!cancelled) setManagers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const print = useCallback(async () => {
    if (!draft || !cashUpReady(draft) || busy) {
      // Unreachable through the button, which is disabled until this is true. Kept because "the
      // button was disabled" is not an authorisation check.
      return;
    }
    setBusy(true);
    setFailure(null);
    setDone(null);

    try {
      const token = await getTerminalToken();
      if (!token) {
        setFailure(Copy.CASH_UP_REPORT_FAILED);
        return;
      }

      // Minted and spent in one press. See the header.
      const auth = await authorizeTerminalAction(
        draft.staffUserId,
        draft.pin.trim(),
        'cash_up',
        token,
      );

      const result = await printCashUp(
        {
          preset,
          staffUserId: draft.staffUserId,
          authorizationTokenId: auth.token_id,
        },
        token,
      );

      if (!result.success) {
        setFailure(
          result.errorCode === 'NO_PRINTER_CONFIGURED'
            ? Copy.CASH_UP_NO_PRINTER
            : Copy.CASH_UP_PRINTER_FAILED,
        );
        return;
      }

      // A quiet period is said on screen too. A manager who reads a blank slip checks the printer
      // rather than believing the number.
      const tookNothing = (result.report?.summary.totalOrders ?? 0) === 0;
      setDone(tookNothing ? Copy.CASH_UP_NOTHING_TAKEN : Copy.CASH_UP_PRINTED);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code ?? null : null;
      setFailure(cashUpFailureMessage(code) ?? Copy.CASH_UP_REPORT_FAILED);
    } finally {
      // The PIN never survives a press, successful or not. It is somebody's code sitting in a
      // field on a device that stays on the counter.
      setDraft(prev => (prev ? {...prev, pin: ''} : prev));
      setBusy(false);
    }
  }, [busy, draft, preset]);

  const ready = cashUpReady(draft) && !busy;

  return (
    <ScrollView contentContainerStyle={styles.container} testID="cash-up-screen">
      <Text style={styles.title}>{Copy.CASH_UP_TITLE}</Text>
      <Text style={styles.intro}>{Copy.CASH_UP_INTRO}</Text>

      <Text style={styles.label}>{Copy.CASH_UP_PERIOD_LABEL}</Text>
      <View style={styles.row}>
        {PERIODS.map(p => (
          <Pressable
            key={p.id}
            testID={`cash-up-period-${p.id}`}
            disabled={busy}
            style={[styles.chip, preset === p.id && styles.chipOn]}
            onPress={() => {
              setPreset(p.id);
              // A period change invalidates what was said about the last one.
              setDone(null);
              setFailure(null);
            }}>
            <Text style={[styles.chipText, preset === p.id && styles.chipTextOn]}>{p.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.hint}>{Copy.CASH_UP_PERIOD_HINT}</Text>

      {managers === null ? (
        <View style={styles.block} testID="cash-up-loading">
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : managers.length === 0 ? (
        <View style={styles.block} testID="cash-up-no-managers">
          <Text style={styles.hint}>{Copy.CASH_UP_NO_MANAGERS}</Text>
        </View>
      ) : (
        <View style={styles.block} testID="cash-up-authorise">
          <Text style={styles.label}>{Copy.CASH_UP_PICK_MANAGER}</Text>
          <Text style={styles.hint}>{Copy.CASH_UP_PIN_REASON}</Text>
          <View style={styles.row}>
            {managers.map(m => (
              <Pressable
                key={m.user_id}
                testID={`cash-up-manager-${m.user_id}`}
                disabled={busy}
                style={[styles.chip, draft?.staffUserId === m.user_id && styles.chipOn]}
                onPress={() => {
                  // Switching who is printing CLEARS THE PIN: otherwise one person's code is sent
                  // under another person's name, and the name is the whole point of the PIN here.
                  setDraft({staffUserId: m.user_id, name: m.name, pin: ''});
                  setFailure(null);
                  setDone(null);
                }}>
                <Text
                  style={[
                    styles.chipText,
                    draft?.staffUserId === m.user_id && styles.chipTextOn,
                  ]}>
                  {m.name}
                </Text>
              </Pressable>
            ))}
          </View>

          {draft ? (
            <TextInput
              testID="cash-up-pin"
              style={styles.input}
              value={draft.pin}
              onChangeText={pin => setDraft({...draft, pin})}
              editable={!busy}
              placeholder={Copy.CASH_UP_PIN_PROMPT.replace('{name}', draft.name)}
              placeholderTextColor={Colors.textMuted}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={12}
            />
          ) : null}
        </View>
      )}

      {failure ? (
        <Text style={styles.failure} testID="cash-up-failure">
          {failure}
        </Text>
      ) : null}
      {done ? (
        <Text style={styles.done} testID="cash-up-done">
          {done}
        </Text>
      ) : null}

      <Pressable
        testID="cash-up-print"
        disabled={!ready}
        onPress={print}
        style={[styles.primary, !ready && styles.primaryDisabled]}>
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.primaryText}>{Copy.CASH_UP_PRINT}</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {padding: Spacing.lg, gap: Spacing.sm},
  title: {...Typography.heading, color: Colors.textPrimary},
  intro: {...Typography.small, color: Colors.textSecondary},
  label: {...Typography.small, color: Colors.textSecondary, marginTop: Spacing.sm},
  hint: {...Typography.small, color: Colors.textMuted},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs},
  block: {
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: Spacing.sm,
  },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#F3F4F6',
  },
  chipOn: {backgroundColor: Colors.primary},
  chipText: {...Typography.small, color: Colors.textPrimary},
  chipTextOn: {color: '#FFFFFF', fontWeight: '700'},
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    ...Typography.body,
    color: Colors.textPrimary,
  },
  failure: {...Typography.small, color: Colors.red, marginTop: Spacing.sm},
  done: {...Typography.small, color: Colors.textPrimary, marginTop: Spacing.sm},
  primary: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  primaryDisabled: {opacity: 0.4},
  primaryText: {...Typography.body, color: '#FFFFFF', fontWeight: '800'},
});
