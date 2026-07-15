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
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {getTables} from '../lib/api';
import {getRestaurantName, getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';
import {TableWithTab} from '../types';

function formatUnpaidTotal(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `NAD ${safe.toFixed(2)}`;
}

function countUnpaidOrders(table: TableWithTab): number {
  if (!table.tab) {
    return 0;
  }
  return table.tab.orders.filter(o => o.payment_status !== 'paid').length;
}

interface TableCardProps {
  table: TableWithTab;
  onPress: () => void;
}

function TableCard({table, onPress}: TableCardProps) {
  const tab = table.tab;
  const orderCount = tab?.orders.length ?? 0;
  const unpaidTotal = tab?.unpaid_total ?? 0;
  const unpaidCount = countUnpaidOrders(table);
  const isReadyToPay = tab?.status === 'ready_to_pay';

  return (
    <Pressable
      style={({pressed}) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}>
      <View style={styles.cardHeader}>
        <Text style={styles.tableTitle}>TABLE {table.table_number}</Text>
        {table.can_close ? (
          <View style={styles.closeBadge}>
            <Text style={styles.closeBadgeText}>Ready to Close</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.orderCount}>
        {orderCount} {orderCount === 1 ? 'order' : 'orders'}
      </Text>

      <View style={styles.cardFooter}>
        <Text style={styles.unpaidTotal}>{formatUnpaidTotal(unpaidTotal)}</Text>
        <View
          style={[
            styles.statusChip,
            isReadyToPay ? styles.statusChipReady : styles.statusChipDefault,
          ]}>
          <Text
            style={[
              styles.statusChipText,
              isReadyToPay
                ? styles.statusChipTextReady
                : styles.statusChipTextDefault,
            ]}>
            {isReadyToPay
              ? 'Ready to Pay'
              : `${unpaidCount} unpaid ${unpaidCount === 1 ? 'order' : 'orders'}`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function TablesScreen() {
  const insets = useSafeAreaInsets();
  const navigation =
    useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const [tables, setTables] = useState<TableWithTab[]>([]);
  const [restaurantName, setRestaurantName] = useState('Restaurant');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTables = useCallback(async (showRefresh = false) => {
    if (showRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const token = await getTerminalToken();
      const name = await getRestaurantName();

      if (!token) {
        throw new Error('Terminal session not found. Please re-activate.');
      }

      if (name) {
        setRestaurantName(name);
      }

      const fetched = await getTables(token);
      setTables(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  // Refetch on every focus (not just mount) — the initial mount fetch above
  // already covers first load, so skip the redundant fetch on that first
  // focus. Without this, returning here after a refund (or any settle
  // elsewhere) shows the pre-refund table list until a manual pull-to-refresh
  // — the root cause of #29.
  const hasFocusedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (hasFocusedOnceRef.current) {
        loadTables(true);
      } else {
        hasFocusedOnceRef.current = true;
      }
    }, [loadTables]),
  );

  const showErrorState = Boolean(error) && !loading && tables.length === 0;

  return (
    <View style={styles.container}>
      <View style={[styles.header, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable
          style={styles.headerIcon}
          onPress={() => navigation.navigate('Settings')}>
          <MaterialCommunityIcons name="menu" size={26} color={Colors.primary} />
        </Pressable>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Tables</Text>
          <Text style={styles.restaurantName} numberOfLines={1}>
            {restaurantName}
          </Text>
        </View>

        <View style={styles.headerIcon} />
      </View>

      {error && !showErrorState ? (
        <Text style={styles.errorBanner}>{error}</Text>
      ) : null}

      {loading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : showErrorState ? (
        <View style={styles.errorState}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={() => loadTables()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={tables}
          keyExtractor={item => item.id}
          contentContainerStyle={
            tables.length === 0 ? styles.emptyList : styles.list
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadTables(true)}
              tintColor={Colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No occupied tables right now</Text>
            </View>
          }
          renderItem={({item}) => (
            <TableCard
              table={item}
              onPress={() =>
                navigation.navigate('TableDetail', {table: item})
              }
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  restaurantName: {
    ...Typography.small,
    color: Colors.textSecondary,
    fontWeight: '600',
    marginTop: 2,
  },
  errorBanner: {
    backgroundColor: Colors.redLight,
    color: Colors.red,
    padding: Spacing.sm,
    textAlign: 'center',
    ...Typography.small,
  },
  list: {
    padding: Spacing.md,
  },
  emptyList: {
    flexGrow: 1,
    padding: Spacing.md,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  loadingState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  errorText: {
    ...Typography.body,
    color: Colors.red,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    minWidth: 120,
    alignItems: 'center',
  },
  retryButtonText: {
    color: Colors.white,
    fontSize: 16,
    fontWeight: '600',
  },
  card: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardPressed: {
    opacity: 0.92,
    backgroundColor: Colors.surface,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  tableTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: Colors.textPrimary,
    flex: 1,
  },
  closeBadge: {
    backgroundColor: Colors.greenLight,
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.green,
  },
  closeBadgeText: {
    ...Typography.tiny,
    fontWeight: '700',
    color: Colors.green,
  },
  orderCount: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: Spacing.sm,
    gap: Spacing.sm,
  },
  unpaidTotal: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  statusChip: {
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: Spacing.sm,
  },
  statusChipReady: {
    backgroundColor: Colors.greenLight,
  },
  statusChipDefault: {
    backgroundColor: Colors.orangeLight,
  },
  statusChipText: {
    ...Typography.tiny,
    fontWeight: '700',
  },
  statusChipTextReady: {
    color: Colors.green,
  },
  statusChipTextDefault: {
    color: Colors.orange,
  },
});
