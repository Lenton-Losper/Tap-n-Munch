import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {ApiRequestError, FloorTable, getFloorTables} from '../lib/api';
import {formatSecondsOpen} from '../lib/serviceRound';
import {getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';

type NavProp = NativeStackNavigationProp<MainStackParamList>;

const REFRESH_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

function formatTotal(amount: number | null | undefined): string {
  const safe = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  return `NAD ${safe.toFixed(2)}`;
}

interface FloorCardProps {
  table: FloorTable;
  /** Seconds elapsed on the DEVICE since the payload was fetched. A duration, never a clock. */
  elapsedSinceLoad: number;
  onPress: () => void;
}

function FloorCard({table, elapsedSinceLoad, onPress}: FloorCardProps) {
  // `state` — never `table_status`. The two disagree in production in both directions (#216, and
  // the abandoned-tab reaper), and the brief returns table_status for diagnosis only.
  const isOpen = table.state === 'open';
  const secondsOpen =
    table.seconds_open != null ? table.seconds_open + elapsedSinceLoad : null;

  return (
    <Pressable
      style={({pressed}) => [
        styles.card,
        isOpen ? styles.cardOpen : styles.cardFree,
        pressed && styles.cardPressed,
      ]}
      onPress={onPress}>
      <View style={styles.cardHeader}>
        <Text style={styles.tableNumber}>{table.table_number}</Text>
        <View
          style={[
            styles.stateChip,
            isOpen ? styles.stateChipOpen : styles.stateChipFree,
          ]}>
          <Text
            style={[
              styles.stateChipText,
              isOpen ? styles.stateChipTextOpen : styles.stateChipTextFree,
            ]}>
            {isOpen ? 'OPEN' : 'FREE'}
          </Text>
        </View>
      </View>

      {table.table_name ? (
        <Text style={styles.tableName} numberOfLines={1}>
          {table.table_name}
        </Text>
      ) : null}

      {isOpen ? (
        <>
          {/* A null owner on an open table is legitimate — a QR-opened tab, or an assignment
              that failed while the tab succeeded. Show the table as open with no name; never
              block on it. */}
          <View style={styles.metaRow}>
            <MaterialCommunityIcons
              name="account-outline"
              size={16}
              color={Colors.textSecondary}
            />
            <Text style={styles.metaText} numberOfLines={1}>
              {table.owner?.name ?? 'Unassigned'}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <MaterialCommunityIcons
              name="clock-outline"
              size={16}
              color={Colors.textSecondary}
            />
            <Text style={styles.metaText}>
              {formatSecondsOpen(secondsOpen) || '—'}
            </Text>
          </View>
          <Text style={styles.tabTotal}>{formatTotal(table.tab?.total)}</Text>
        </>
      ) : (
        <Text style={styles.freeHint}>Tap to open</Text>
      )}
    </Pressable>
  );
}

export default function ServiceFloorScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavProp>();
  const {beginSession, endSession} = useServiceSession();

  const [tables, setTables] = useState<FloorTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Non-null only for the unrecoverable 403 case. Everything else is a soft banner. */
  const [hardError, setHardError] = useState<string | null>(null);
  const [softError, setSoftError] = useState<string | null>(null);
  const [loadedAtMs, setLoadedAtMs] = useState<number | null>(null);
  const [elapsedSinceLoad, setElapsedSinceLoad] = useState(0);

  const backoffRef = useRef(REFRESH_INTERVAL_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);

  const load = useCallback(async (mode: 'initial' | 'pull' | 'poll') => {
    if (mode === 'pull') {
      setRefreshing(true);
    } else if (mode === 'initial') {
      setLoading(true);
    }

    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Terminal session not found. Re-activate this terminal.');
      }
      const payload = await getFloorTables(token);
      const sorted = [...payload.tables].sort(
        (a, b) => a.table_number - b.table_number,
      );
      setTables(sorted);
      setLoadedAtMs(Date.now());
      setElapsedSinceLoad(0);
      setHardError(null);
      setSoftError(null);
      backoffRef.current = REFRESH_INTERVAL_MS;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) {
        // Not recoverable on the device: the terminal token itself lacks orders:read.
        setHardError(
          `${err.message}. This terminal is not permitted to read tables — a manager must fix its role in the dashboard.`,
        );
      } else {
        // Keep showing the last good grid and retry with backoff.
        setSoftError(
          err instanceof Error ? err.message : 'Failed to load the floor',
        );
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Poll on a timer while focused. Rescheduled from the tail of each attempt rather than on a
  // fixed interval, so a slow response cannot stack requests on top of each other.
  const scheduleNext = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(async () => {
      if (!focusedRef.current) {
        return;
      }
      await load('poll');
      if (focusedRef.current) {
        scheduleNext();
      }
    }, backoffRef.current);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      // Arriving at the grid by ANY route drops the held waiter — Back out of a round, a cancel,
      // or the return after a Send. The next table must cost a PIN again.
      endSession();
      load('initial').then(() => scheduleNext());
      return () => {
        focusedRef.current = false;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }, [endSession, load, scheduleNext]),
  );

  // Ticks the "time open" counters between refreshes. Measures a DURATION from a locally-recorded
  // instant, which is safe; it never rebuilds the figure from `opened_at` and the device clock,
  // which is not — a terminal off a shelf has no trustworthy wall clock.
  useEffect(() => {
    if (loadedAtMs == null) {
      return;
    }
    const id = setInterval(() => {
      setElapsedSinceLoad(Math.floor((Date.now() - loadedAtMs) / 1000));
    }, 30_000);
    return () => clearInterval(id);
  }, [loadedAtMs]);

  const handlePress = useCallback(
    (table: FloorTable) => {
      if (table.state === 'open') {
        if (!table.tab?.id) {
          // Open with no tab id is a shape we cannot act on; a refresh is the honest answer.
          setSoftError('That table is open but its tab could not be read. Refreshing.');
          load('pull');
          return;
        }
        // No PIN to join an already-open table. Ruling E/F in the brief: allow it, show whose
        // table it is, do not block — a hard block strands a table when a waiter is on break.
        beginSession(
          table.owner
            ? {userId: table.owner.user_id, name: table.owner.name}
            : null,
          {
            tableId: table.id,
            tableNumber: table.table_number,
            tableName: table.table_name,
            tabId: table.tab.id,
            ownerName: table.owner?.name ?? null,
          },
        );
        navigation.navigate('ServiceRound');
        return;
      }

      navigation.navigate('ServiceOpenTable', {
        tableId: table.id,
        tableNumber: table.table_number,
        tableName: table.table_name,
      });
    },
    [beginSession, load, navigation],
  );

  if (hardError) {
    return (
      <View style={[styles.wrapper, {paddingTop: insets.top}]}>
        <View style={styles.centered}>
          <MaterialCommunityIcons
            name="lock-alert-outline"
            size={44}
            color={Colors.red}
          />
          <Text style={styles.hardErrorText}>{hardError}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.wrapper, {paddingTop: insets.top}]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Floor</Text>
        <Text style={styles.headerSubtitle}>
          {tables.filter(t => t.state === 'open').length} open ·{' '}
          {tables.filter(t => t.state === 'free').length} free
        </Text>
      </View>

      {softError ? (
        <View style={styles.softBanner}>
          <MaterialCommunityIcons
            name="wifi-off"
            size={16}
            color={Colors.amber}
          />
          <Text style={styles.softBannerText} numberOfLines={2}>
            {softError}
          </Text>
        </View>
      ) : null}

      {loading && tables.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={tables}
          keyExtractor={item => item.id}
          numColumns={2}
          contentContainerStyle={
            tables.length === 0 ? styles.emptyList : styles.list
          }
          columnWrapperStyle={tables.length === 0 ? undefined : styles.column}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load('pull')}
              tintColor={Colors.primary}
            />
          }
          renderItem={({item}) => (
            <FloorCard
              table={item}
              elapsedSinceLoad={elapsedSinceLoad}
              onPress={() => handlePress(item)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>
                No active tables for this restaurant.
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
  header: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {...Typography.heading, color: Colors.textPrimary},
  headerSubtitle: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  softBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.amberLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  softBannerText: {flex: 1, ...Typography.tiny, color: Colors.amber},
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  list: {padding: Spacing.sm},
  emptyList: {flexGrow: 1},
  column: {gap: Spacing.sm},
  card: {
    flex: 1,
    margin: Spacing.xs,
    padding: Spacing.md,
    borderRadius: 14,
    borderWidth: 1.5,
    minHeight: 148,
  },
  cardOpen: {backgroundColor: Colors.blueLight, borderColor: Colors.blue},
  cardFree: {backgroundColor: Colors.background, borderColor: Colors.border},
  cardPressed: {opacity: 0.85},
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tableNumber: {fontSize: 34, fontWeight: '800', color: Colors.textPrimary},
  stateChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: 999,
  },
  stateChipOpen: {backgroundColor: Colors.blue},
  stateChipFree: {backgroundColor: Colors.border},
  stateChipText: {fontSize: 11, fontWeight: '800', letterSpacing: 0.5},
  stateChipTextOpen: {color: Colors.white},
  stateChipTextFree: {color: Colors.textSecondary},
  tableName: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginTop: Spacing.xs,
  },
  metaText: {flex: 1, ...Typography.small, color: Colors.textSecondary},
  tabTotal: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
  },
  freeHint: {
    ...Typography.small,
    color: Colors.textMuted,
    marginTop: Spacing.md,
  },
  hardErrorText: {
    ...Typography.body,
    color: Colors.red,
    textAlign: 'center',
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
  },
});
