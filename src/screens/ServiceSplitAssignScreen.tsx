import React, {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/serviceCopy';
import {allocateLine, getTabLines} from '../lib/api';
import {getTerminalToken} from '../lib/storage';
import {
  assignableNames,
  canSplitLine,
  formatCents,
  personSplits,
  sharesFor,
  splitRefusal,
  unallocatedCents,
  type ShareMode,
  type SplittableLine,
} from '../lib/splitBill';
import type {TabLine, TabLinesPayload} from '../lib/tabLines';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceSplitAssign'>;

/**
 * SPLIT, SCREEN 1 — who is paying for each item.
 *
 * ============================================================================================
 * THE FREE NAME FIELD IS PRIMARY, AND THAT IS A MEASURED DECISION
 * ============================================================================================
 *
 * The obvious design offers `tabs.members` and lets the waiter pick. Measured on production
 * 2026-09-03, that list is empty exactly where this screen is used:
 *
 *     QR / unattributed tabs : 21 of 21 have members
 *     WAITER-OPENED tabs     :  0 of 12 have members
 *
 * Every Riviera tab since 2026-09-01 is waiter-opened with zero members. `members` entries are QR
 * SESSION records ({session_id, display_name, joined_at}) written when a customer scans; the
 * waiter open-table flow writes none. A members-first picker would therefore be a picker over an
 * empty list, every time, for the only flow that reaches this screen.
 *
 * So the field leads. What sits above it are names ALREADY USED ON THIS TAB, which is where the
 * real "do not retype" value is: assigning the second line to the same person as the first is the
 * common motion, and that list is never empty by the time it matters. Members are still offered
 * when they exist, costing nothing.
 *
 * `tabs.customer_name` IS NEVER OFFERED AS A PAYER. It is the table's label ("Bob", "Bobby") and
 * not a diner, and treating a table label as a person is the same overloading that was ruled
 * against for the receipt name.
 *
 * ============================================================================================
 * THIS SCREEN NEVER COMPUTES AN AMOUNT
 * ============================================================================================
 *
 * It sends WEIGHTS (1, or 0.5/0.5) and displays cents the server returned. The server divides with
 * splitCentsByWeight() in integer cents, so an odd-cent line comes back as 1667/1666 summing
 * exactly. A second division here would be a second answer to the same question, disagreeing on
 * precisely the input that matters. See lib/splitBill.ts.
 *
 * HALF ONLY — the owner ruled out N-way: three people sharing a pizza is a rounding argument at
 * the table, and an N-way control is more ways to mis-tap mid-service.
 */
export default function ServiceSplitAssignScreen({route, navigation}: Props) {
  const {tabId, tableNumber} = route.params;
  const insets = useSafeAreaInsets();

  const [payload, setPayload] = useState<TabLinesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);

  const [selectedLine, setSelectedLine] = useState<TabLine | null>(null);
  const [primaryName, setPrimaryName] = useState('');
  const [secondName, setSecondName] = useState('');
  const [mode, setMode] = useState<ShareMode>('whole');

  const load = useCallback(async () => {
    try {
      const token = await getTerminalToken();
      if (!token) {
        setError('This terminal is not signed in.');
        return;
      }
      const next = await getTabLines(tabId, token);
      setPayload(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this table.');
    } finally {
      setLoading(false);
    }
  }, [tabId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const lines: TabLine[] = useMemo(
    () => (payload?.orders ?? []).flatMap(o => o.lines),
    [payload],
  );

  /** Names to offer, best-first. Never includes the tab's own customer_name. */
  const suggestions = useMemo(
    () => assignableNames(memberDisplayNames(payload), lines as SplittableLine[]),
    [payload, lines],
  );

  const people = useMemo(() => personSplits(lines as SplittableLine[]), [lines]);

  const assign = useCallback(async () => {
    if (!selectedLine) {
      return;
    }
    const name = primaryName.trim();
    if (!name) {
      return;
    }
    setBusyLineId(selectedLine.id);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setError('This terminal is not signed in.');
        return;
      }
      await allocateLine(
        tabId,
        selectedLine.id,
        sharesFor(mode, name, mode === 'half' ? secondName : null),
        token,
      );
      setSelectedLine(null);
      setPrimaryName('');
      setSecondName('');
      setMode('whole');
      // Re-read rather than patching local state: the server decides the amounts, and a screen
      // that guessed them would drift from the ledger on the first odd-cent line.
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign this item.');
    } finally {
      setBusyLineId(null);
    }
  }, [selectedLine, primaryName, secondName, mode, tabId, load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={12} testID="split-back">
          <MaterialCommunityIcons name="chevron-left" size={30} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>{Copy.SPLIT_ASSIGN_TITLE}</Text>
        <Text style={styles.headerTable}>{tableNumber}</Text>
      </View>

      {error ? (
        <View style={styles.errorBanner} testID="split-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.body}>
        {lines.map(line => {
          const remaining = unallocatedCents(line as SplittableLine);
          const refusal = splitRefusal(line as SplittableLine);
          const assignable = canSplitLine(line as SplittableLine);
          const allocations = line.allocations ?? [];

          return (
            <Pressable
              key={line.id}
              testID={`split-line-${line.id}`}
              disabled={!assignable || busyLineId != null}
              onPress={() => {
                setSelectedLine(line);
                setPrimaryName('');
                setSecondName('');
                setMode('whole');
              }}
              style={[
                styles.lineRow,
                !assignable && styles.lineRowDisabled,
                selectedLine?.id === line.id && styles.lineRowSelected,
              ]}>
              <Text style={styles.lineQty}>{line.quantity}×</Text>
              <View style={styles.lineMain}>
                <Text style={styles.lineName} numberOfLines={2}>
                  {line.name_snapshot}
                </Text>

                {/* Who it is already assigned to, and whether they have paid. */}
                {allocations.map(a => (
                  <Text key={a.id} style={styles.allocationText} testID={`split-alloc-${a.id}`}>
                    {a.allocated_to} · {formatCents(a.amount_cents)}
                    {a.settled_at ? ' · paid' : ''}
                  </Text>
                ))}

                {/* A voided or unpriceable line says WHY it cannot be split, rather than being an
                    inert row that does not respond to a tap. */}
                {refusal === 'voided' ? (
                  <Text style={styles.refusalText}>{Copy.SPLIT_LINE_VOIDED}</Text>
                ) : null}
              </View>

              <Text style={styles.lineAmount}>
                {remaining == null ? '—' : formatCents(remaining)}
              </Text>
            </Pressable>
          );
        })}

        {/* The unassigned remainder across the whole table, so a waiter can see when they are done. */}
        <Text style={styles.unassigned} testID="split-unassigned">
          {Copy.SPLIT_UNASSIGNED.replace(
            '{amount}',
            formatCents(
              lines.reduce((sum, l) => sum + (unallocatedCents(l as SplittableLine) ?? 0), 0),
            ),
          )}
        </Text>

        {people.length > 0 ? (
          <View style={styles.peopleBlock}>
            {people.map(p => (
              <Pressable
                key={p.name}
                testID={`split-person-${p.name}`}
                style={styles.personRow}
                onPress={() =>
                  navigation.navigate('ServiceSplitCollect', {
                    tabId,
                    tableNumber,
                    name: p.name,
                  })
                }>
                <Text style={styles.personName}>{p.name}</Text>
                <Text style={styles.personAmount}>
                  {Copy.SPLIT_COLLECT_TOTAL.replace('{name}', p.name).replace(
                    '{amount}',
                    formatCents(p.unsettledCents),
                  )}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* The assign sheet. The FREE FIELD LEADS -- see the docblock. */}
      {selectedLine ? (
        <View style={[styles.sheet, {paddingBottom: insets.bottom + Spacing.md}]}>
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {selectedLine.name_snapshot}
          </Text>

          <TextInput
            testID="split-name-input"
            style={styles.nameInput}
            value={primaryName}
            onChangeText={setPrimaryName}
            placeholder={Copy.SPLIT_PERSON_PLACEHOLDER}
            placeholderTextColor={Colors.textMuted}
            maxLength={60}
            autoFocus
          />

          {/* One-tap names already on this tab. Never the tab's customer_name. */}
          {suggestions.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {suggestions.map(name => (
                <Pressable
                  key={name}
                  testID={`split-suggest-${name}`}
                  style={styles.chip}
                  onPress={() => (mode === 'half' && primaryName ? setSecondName(name) : setPrimaryName(name))}>
                  <Text style={styles.chipText}>{name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}

          <View style={styles.modeRow}>
            <Pressable
              testID="split-mode-whole"
              style={[styles.modeButton, mode === 'whole' && styles.modeButtonActive]}
              onPress={() => setMode('whole')}>
              <Text style={[styles.modeText, mode === 'whole' && styles.modeTextActive]}>
                {Copy.SPLIT_SHARE_WHOLE}
              </Text>
            </Pressable>
            <Pressable
              testID="split-mode-half"
              style={[styles.modeButton, mode === 'half' && styles.modeButtonActive]}
              onPress={() => setMode('half')}>
              <Text style={[styles.modeText, mode === 'half' && styles.modeTextActive]}>
                {Copy.SPLIT_SHARE_HALF}
              </Text>
            </Pressable>
          </View>

          {mode === 'half' ? (
            <TextInput
              testID="split-second-name-input"
              style={styles.nameInput}
              value={secondName}
              onChangeText={setSecondName}
              placeholder={Copy.SPLIT_PERSON_PLACEHOLDER}
              placeholderTextColor={Colors.textMuted}
              maxLength={60}
            />
          ) : null}

          <Pressable
            testID="split-assign-confirm"
            disabled={!primaryName.trim() || busyLineId != null}
            onPress={assign}
            style={[
              styles.confirmButton,
              (!primaryName.trim() || busyLineId != null) && styles.confirmButtonDisabled,
            ]}>
            {busyLineId ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.confirmText}>{Copy.SPLIT_ADD_PERSON}</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

/**
 * `tabs.members` entries are QR session records, so the human name is `display_name`. Extracted
 * defensively: the column is jsonb and a malformed entry must not take the screen down.
 */
function memberDisplayNames(payload: TabLinesPayload | null): string[] {
  const raw = (payload?.tab as unknown as {members?: unknown})?.members;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map(m => (m && typeof m === 'object' ? String((m as {display_name?: unknown}).display_name ?? '') : ''))
    .map(s => s.trim())
    .filter(Boolean);
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: Colors.background},
  centered: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  headerTitle: {...Typography.heading, color: Colors.textPrimary, flex: 1},
  headerTable: {...Typography.body, color: Colors.textSecondary, fontWeight: '800'},
  errorBanner: {backgroundColor: '#FEF2F2', padding: Spacing.sm, marginHorizontal: Spacing.md},
  errorText: {...Typography.small, color: '#991B1B'},
  body: {padding: Spacing.md, gap: Spacing.xs},
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: Spacing.sm,
  },
  lineRowDisabled: {opacity: 0.5},
  lineRowSelected: {borderWidth: 2, borderColor: Colors.primary},
  lineQty: {...Typography.body, fontWeight: '800', color: Colors.textPrimary},
  lineMain: {flex: 1},
  lineName: {...Typography.body, color: Colors.textPrimary},
  lineAmount: {...Typography.body, fontWeight: '700', color: Colors.textPrimary},
  allocationText: {...Typography.small, color: Colors.textSecondary, marginTop: 2},
  refusalText: {...Typography.small, color: '#991B1B', marginTop: 2},
  unassigned: {...Typography.small, color: Colors.textSecondary, marginTop: Spacing.sm},
  peopleBlock: {marginTop: Spacing.md, gap: Spacing.xs},
  personRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: Spacing.sm,
  },
  personName: {...Typography.body, fontWeight: '700', color: Colors.textPrimary},
  personAmount: {...Typography.small, color: Colors.textSecondary},
  sheet: {
    backgroundColor: '#FFFFFF',
    padding: Spacing.md,
    gap: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  sheetTitle: {...Typography.body, fontWeight: '800', color: Colors.textPrimary},
  nameInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    ...Typography.body,
    color: Colors.textPrimary,
  },
  chipRow: {flexGrow: 0},
  chip: {
    backgroundColor: '#F3F4F6',
    borderRadius: 999,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    marginRight: Spacing.xs,
  },
  chipText: {...Typography.small, color: Colors.textPrimary},
  modeRow: {flexDirection: 'row', gap: Spacing.xs},
  modeButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  modeButtonActive: {backgroundColor: Colors.primary},
  modeText: {...Typography.body, color: Colors.textPrimary},
  modeTextActive: {color: '#FFFFFF', fontWeight: '700'},
  confirmButton: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  confirmButtonDisabled: {opacity: 0.4},
  confirmText: {...Typography.body, color: '#FFFFFF', fontWeight: '800'},
});
