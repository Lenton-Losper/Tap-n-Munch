import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  ApiRequestError,
  AuthorizationDeniedError,
  AuthorizedUser,
  authorizeAction,
  getAuthorizedUsers,
  isPinLockedError,
  openServiceTable,
  staffMessageForPinLock,
} from '../lib/api';
import {getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';
import * as Copy from '../constants/serviceCopy';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceOpenTable'>;

/**
 * The purpose string is part of the contract, not a label. GET /authorized-users filters on it and
 * POST /authorize scopes the issued token to it — a `refund` token will not open a table.
 */
const PURPOSE = 'service_session';

const EMPTY_LIST_MESSAGE =
  'No staff are set up to take orders on this terminal.';

export default function ServiceOpenTableScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {tableId, tableNumber, tableName} = route.params;
  /**
   * Where a successful open lands.
   *
   * 'table' — the waiter tapped a FREE table on the floor and is being shown what they just
   *           opened, which is an empty table view with an Add Round button.
   * 'round' — the waiter was already looking at a table and pressed Add Round, so the PIN they
   *           have just paid buys them the round screen directly rather than bouncing them back
   *           to the view they came from and asking them to press the same button again.
   *
   * Defaults to 'table' so any caller that forgets it gets the safe, non-skipping path.
   */
  const next = route.params.next ?? 'table';
  const {beginSession} = useServiceSession();

  const [users, setUsers] = useState<AuthorizedUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AuthorizedUser | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const pinInputRef = useRef<TextInput>(null);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    setListError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Terminal session not found. Re-activate this terminal.');
      }
      setUsers(await getAuthorizedUsers(PURPOSE, token));
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : 'Failed to load staff',
      );
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const backToGrid = useCallback(
    (message?: string) => {
      if (message) {
        setListError(message);
      }
      navigation.goBack();
    },
    [navigation],
  );

  const handleConfirm = useCallback(async () => {
    if (!selected || pin.length !== 4 || busy || locked) {
      return;
    }
    setBusy(true);
    setPinError(null);

    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Terminal session not found. Re-activate this terminal.');
      }

      // Step 2b. authorizeAction deliberately bypasses terminalFetch: a 401 HERE is a wrong PIN,
      // and refreshing the terminal token in answer to it is the loop that produced #327.
      const auth = await authorizeAction(
        {userId: selected.user_id, pin, purpose: PURPOSE},
        token,
      );

      // Step 2c, IMMEDIATELY. The token is single-use and lives 90 seconds. Nothing goes between
      // these two calls — no confirmation, no navigation, no caching of token_id.
      const opened = await openServiceTable(
        {
          tableId,
          userId: selected.user_id,
          authorizationTokenId: auth.token_id,
          customerName,
        },
        token,
      );

      // already_open === true IS A SUCCESS. Two waiters tapped the same table, or the grid was
      // stale; the device is being handed the live tab. Proceed exactly as if it had just opened.
      beginSession(
        {userId: selected.user_id, name: selected.name},
        {
          tableId: opened.table?.id ?? tableId,
          tableNumber: opened.table?.table_number ?? tableNumber,
          tableName,
          tabId: opened.tab.id,
          ownerName: opened.owner?.name ?? selected.name,
        },
      );

      // `handed_over_from` non-null means this table was taken from another waiter. The brief
      // requires the person doing it to be told — silently reassigning a colleague's table is how
      // two people believe they are serving it.
      const takenFrom = opened.handed_over_from ?? null;

      if (next === 'round') {
        navigation.replace('ServiceRound');
        return;
      }

      navigation.replace('ServiceTable', {
        tableId: opened.table?.id ?? tableId,
        tableNumber: opened.table?.table_number ?? tableNumber,
        tableName,
        tabId: opened.tab.id,
        ownerName: opened.owner?.name ?? selected.name,
        ownerUserId: opened.owner?.user_id ?? selected.user_id,
        adoptedExistingTab: opened.already_open === true,
        handedOverFrom: takenFrom,
      });
    } catch (err) {
      setPin('');

      if (err instanceof ApiRequestError && isPinLockedError(err)) {
        setLocked(true);
        setPinError(staffMessageForPinLock(err));
        return;
      }

      if (err instanceof AuthorizationDeniedError) {
        if (err.status === 403) {
          // Not a member, no permission, or no PIN set. Re-prompting cannot help.
          setPinError('This staff member cannot open tables.');
          return;
        }
        // 401 PIN_MISMATCH — wrong PIN, ask again.
        const left = err.attemptsRemaining;
        setPinError(
          left != null && left >= 0
            ? `Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} remaining.`
            : 'Incorrect PIN. Please try again.',
        );
        pinInputRef.current?.focus();
        return;
      }

      if (err instanceof ApiRequestError) {
        // Every AUTHORIZATION_* is a 403 and has already consumed the PIN entry — re-prompt.
        if (err.code?.startsWith('AUTHORIZATION_')) {
          setPinError(
            err.code === 'AUTHORIZATION_EXPIRED'
              ? 'That PIN authorization timed out. Enter the PIN again.'
              : 'That PIN authorization could not be used. Enter the PIN again.',
          );
          pinInputRef.current?.focus();
          return;
        }
        if (err.status === 403) {
          setPinError(
            `${err.message}. This terminal is not permitted to open tables — a manager must fix its role in the dashboard.`,
          );
          return;
        }
        // 404 / 409: the table is gone or was deactivated. The PIN was NOT burned — the table is
        // validated before the token is consumed — but the grid is stale, so go back and refresh.
        if (err.status === 404 || err.status === 409) {
          backToGrid(err.message);
          return;
        }
      }

      setPinError(
        err instanceof Error
          ? err.message
          : 'Could not open the table. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [
    backToGrid,
    beginSession,
    busy,
    customerName,
    locked,
    navigation,
    next,
    pin,
    selected,
    tableId,
    tableName,
    tableNumber,
  ]);

  // Back off the PIN pad returns to the waiter list; back off the list leaves for the grid.
  const handleBack = useCallback(() => {
    if (selected) {
      setSelected(null);
      setPin('');
      setPinError(null);
      setLocked(false);
      return;
    }
    navigation.goBack();
  }, [navigation, selected]);

  const title = tableName
    ? `Table ${tableNumber} · ${tableName}`
    : `Table ${tableNumber}`;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable style={styles.backButton} onPress={handleBack}>
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>
        <Text style={styles.screenTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.backButton} />
      </View>

      {selected ? (
        <KeyboardAvoidingView
          style={styles.content}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Text style={styles.pinTitle}>Enter PIN for {selected.name}</Text>

          <Text style={styles.customerNameLabel}>
            {Copy.OPEN_TABLE_CUSTOMER_NAME_LABEL}
          </Text>
          <TextInput
            style={styles.customerNameInput}
            value={customerName}
            onChangeText={setCustomerName}
            placeholder={Copy.OPEN_TABLE_CUSTOMER_NAME_PLACEHOLDER}
            placeholderTextColor={Colors.textMuted}
            maxLength={100}
            editable={!busy && !locked}
            returnKeyType="next"
            onSubmitEditing={() => pinInputRef.current?.focus()}
          />

          <TextInput
            ref={pinInputRef}
            style={styles.input}
            value={pin}
            onChangeText={text => {
              // Client-side validation first: the route rejects anything that is not exactly
              // four digits with a 400, and burning a round-trip to learn that helps nobody.
              setPin(text.replace(/\D/g, '').slice(0, 4));
              setPinError(null);
            }}
            placeholder="••••"
            placeholderTextColor={Colors.textMuted}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            editable={!busy && !locked}
            autoFocus
          />

          {pinError ? <Text style={styles.pinError}>{pinError}</Text> : null}

          <Pressable
            style={[
              styles.primaryButton,
              (pin.length !== 4 || busy || locked) && styles.buttonDisabled,
            ]}
            onPress={handleConfirm}
            disabled={pin.length !== 4 || busy || locked}>
            {busy ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.primaryButtonText}>Open Table</Text>
            )}
          </Pressable>
        </KeyboardAvoidingView>
      ) : loadingUsers ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : listError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{listError}</Text>
          <Pressable style={styles.retryButton} onPress={loadUsers}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={item => item.user_id}
          contentContainerStyle={
            users.length === 0 ? styles.emptyList : styles.list
          }
          renderItem={({item}) => (
            <Pressable
              style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => {
                setSelected(item);
                setPin('');
                setPinError(null);
                setLocked(false);
              }}>
              <MaterialCommunityIcons
                name="account-outline"
                size={24}
                color={Colors.primary}
              />
              <Text style={styles.userName}>{item.name}</Text>
              <MaterialCommunityIcons
                name="chevron-right"
                size={22}
                color={Colors.textMuted}
              />
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              {/* An empty list is an OPERATIONAL problem, not a code one: a waiter needs both a
                  PIN credential and the orders:update permission to appear here. */}
              <Text style={styles.emptyText}>{EMPTY_LIST_MESSAGE}</Text>
              <Text style={styles.emptyHint}>
                Each waiter needs a PIN and the orders:update permission in the
                dashboard before they show up here.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: Colors.surface},
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  screenTitle: {
    flex: 1,
    textAlign: 'center',
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  content: {flex: 1, justifyContent: 'center', paddingHorizontal: Spacing.xl},
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  list: {padding: Spacing.md},
  emptyList: {flexGrow: 1},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    elevation: 2,
  },
  rowPressed: {opacity: 0.92, backgroundColor: Colors.surface},
  userName: {
    flex: 1,
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  pinTitle: {
    ...Typography.heading,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  customerNameLabel: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginBottom: Spacing.xs,
  },
  customerNameInput: {
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    fontSize: 17,
    color: Colors.textPrimary,
    marginBottom: Spacing.lg,
  },
  input: {
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 16,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 8,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  pinError: {
    color: Colors.red,
    ...Typography.small,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: Spacing.lg,
    alignItems: 'center',
  },
  buttonDisabled: {opacity: 0.6},
  primaryButtonText: {color: Colors.white, ...Typography.subheading},
  errorText: {...Typography.body, color: Colors.red, textAlign: 'center'},
  emptyText: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  emptyHint: {
    ...Typography.small,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  retryButtonText: {color: Colors.textPrimary, fontSize: 17, fontWeight: '600'},
});
