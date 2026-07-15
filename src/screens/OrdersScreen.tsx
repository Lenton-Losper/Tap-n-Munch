import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import OrderCard from '../components/OrderCard';
import {APP_VERSION} from '../constants';
import {Colors, Spacing, Typography} from '../constants/theme';
import {useStreamConnection} from '../context/StreamContext';
import {connectToOrderStream, getOrders, sendHeartbeat} from '../lib/api';
import {
  getRestaurantId,
  getRestaurantName,
  getTerminalToken,
} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';
import {Order} from '../types';

type Tab = 'new' | 'preparing' | 'ready' | 'completed';

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

const TAB_CONFIG: {
  key: Tab;
  label: string;
  color: string;
  match: (order: Order) => boolean;
  emptyMessage: string;
}[] = [
  {
    key: 'new',
    label: 'New Orders',
    color: Colors.orange,
    match: o => o.status === 'pending',
    emptyMessage: 'No new orders right now',
  },
  {
    key: 'preparing',
    label: 'Preparing',
    color: Colors.blue,
    match: o => o.status === 'confirmed' || o.status === 'preparing',
    emptyMessage: 'Nothing in preparation',
  },
  {
    key: 'ready',
    label: 'Ready',
    color: Colors.green,
    match: o => o.status === 'ready',
    emptyMessage: 'No orders ready to serve',
  },
  {
    key: 'completed',
    label: 'Completed',
    color: Colors.textMuted,
    match: o => o.status === 'completed',
    emptyMessage: 'No completed orders yet',
  },
];

function sortOrders(orders: Order[]): Order[] {
  return [...orders].sort(
    (a, b) => new Date(b.placed_at).getTime() - new Date(a.placed_at).getTime(),
  );
}

export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const navigation =
    useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const {setConnectionStatus} = useStreamConnection();
  const [activeTab, setActiveTab] = useState<Tab>('new');
  const [orders, setOrders] = useState<Order[]>([]);
  const [restaurantName, setRestaurantName] = useState('Restaurant');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasNewNotification, setHasNewNotification] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const restaurantIdRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  const newOrderCount = orders.filter(o => o.status === 'pending').length;

  const loadOrders = useCallback(async (showRefresh = false) => {
    if (showRefresh) {
      setRefreshing(true);
    } else if (!tokenRef.current) {
      setLoading(true);
    }
    setError(null);

    try {
      const token = tokenRef.current ?? (await getTerminalToken());
      const name = await getRestaurantName();

      if (!token) {
        throw new Error('Terminal session not found. Please re-activate.');
      }

      tokenRef.current = token;
      if (name) {
        setRestaurantName(name);
      }

      const restaurantId =
        restaurantIdRef.current ?? (await getRestaurantId());
      if (restaurantId) {
        restaurantIdRef.current = restaurantId;
      }

      const fetched = await getOrders(token);
      // Completed orders stay visible (Completed tab) so staff can reach the
      // refund entry point on OrderDetail; cancelled orders were never paid
      // and have nothing to show here.
      setOrders(sortOrders(fetched.filter(o => o.status !== 'cancelled')));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    async function init() {
      const token = await getTerminalToken();
      if (!token) {
        setLoading(false);
        setConnectionStatus('disconnected');
        return;
      }

      tokenRef.current = token;
      restaurantIdRef.current = await getRestaurantId();
      await loadOrders();
      sendHeartbeat(token, APP_VERSION).catch(() => {});
    }

    init();
  }, [loadOrders, setConnectionStatus]);

  // Refetch whenever this screen regains focus (e.g. returning from a
  // refund) so the Completed tab never shows a stale PAID badge — mirrors
  // the same fix applied to TablesScreen/TableDetailScreen for #29.
  const hasFocusedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (hasFocusedOnceRef.current) {
        loadOrders(true);
      } else {
        hasFocusedOnceRef.current = true;
      }
    }, [loadOrders]),
  );

  useEffect(() => {
    const pollId = setInterval(() => {
      loadOrders(true);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollId);
  }, [loadOrders]);

  useEffect(() => {
    const heartbeatId = setInterval(async () => {
      const token = tokenRef.current ?? (await getTerminalToken());
      if (token) {
        sendHeartbeat(token, APP_VERSION).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(heartbeatId);
  }, []);

  useEffect(() => {
    let disconnectStream: (() => void) | null = null;

    async function startStream() {
      const token = tokenRef.current ?? (await getTerminalToken());
      if (!token) {
        setConnectionStatus('disconnected');
        return;
      }

      setConnectionStatus('checking');

      disconnectStream = connectToOrderStream(
        token,
        event => {
          if (event.type === 'order.created' || event.type === 'order.new') {
            Vibration.vibrate(400);
            setHasNewNotification(true);
          }
          loadOrders(true);
        },
        () => {
          setStreamConnected(true);
          setConnectionStatus('connected');
        },
        () => {
          setStreamConnected(false);
          setConnectionStatus('disconnected');
        },
      );
    }

    if (!loading) {
      startStream();
    }

    return () => {
      disconnectStream?.();
      setStreamConnected(false);
      setConnectionStatus('disconnected');
    };
  }, [loading, loadOrders, setConnectionStatus]);

  const handleTabPress = (tab: Tab) => {
    setActiveTab(tab);
    if (tab === 'new') {
      setHasNewNotification(false);
    }
  };

  const activeTabConfig = TAB_CONFIG.find(t => t.key === activeTab)!;
  const filteredOrders = orders.filter(activeTabConfig.match);

  return (
    <View style={styles.container}>
      <View style={[styles.header, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable
          style={styles.headerIcon}
          onPress={() => navigation.navigate('Settings')}>
          <MaterialCommunityIcons name="menu" size={26} color={Colors.primary} />
        </Pressable>

        <View style={styles.headerCenter}>
          <View style={styles.titleRow}>
            <View
              style={[
                styles.connectionDot,
                {
                  backgroundColor: streamConnected ? Colors.green : Colors.red,
                },
              ]}
            />
            <Text style={styles.headerTitle}>Live Orders</Text>
          </View>
          <Text style={styles.restaurantName} numberOfLines={1}>
            {restaurantName}
          </Text>
        </View>

        <Pressable
          style={styles.headerIcon}
          onPress={() => {
            setHasNewNotification(false);
            setActiveTab('new');
          }}>
          <MaterialCommunityIcons
            name="bell-outline"
            size={26}
            color={Colors.primary}
          />
          {hasNewNotification || newOrderCount > 0 ? (
            <View style={styles.notificationDot} />
          ) : null}
        </Pressable>
      </View>

      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      <View style={styles.tabs}>
        {TAB_CONFIG.map(tab => {
          const isActive = activeTab === tab.key;
          const count = tab.key === 'new' ? newOrderCount : 0;
          const label =
            tab.key === 'new' && count > 0
              ? `${tab.label} (${count})`
              : tab.label;

          return (
            <Pressable
              key={tab.key}
              style={styles.tab}
              onPress={() => handleTabPress(tab.key)}>
              <Text
                style={[
                  styles.tabText,
                  isActive && {color: tab.color, fontWeight: '700'},
                ]}>
                {label}
              </Text>
              {isActive ? (
                <View style={[styles.tabIndicator, {backgroundColor: tab.color}]} />
              ) : (
                <View style={styles.tabIndicatorPlaceholder} />
              )}
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filteredOrders}
          keyExtractor={item => item.id}
          contentContainerStyle={
            filteredOrders.length === 0 ? styles.emptyList : styles.list
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadOrders(true)}
              tintColor={Colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>
                {activeTabConfig.emptyMessage}
              </Text>
            </View>
          }
          renderItem={({item}) => (
            <OrderCard
              order={item}
              onPress={() =>
                navigation.navigate('OrderDetail', {orderId: item.id})
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  restaurantName: {
    ...Typography.small,
    color: Colors.textSecondary,
    fontWeight: '600',
    marginTop: 2,
  },
  headerTitle: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  notificationDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.green,
    borderWidth: 2,
    borderColor: Colors.background,
  },
  errorBanner: {
    backgroundColor: Colors.redLight,
    color: Colors.red,
    padding: Spacing.sm,
    textAlign: 'center',
    ...Typography.small,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  tabText: {
    ...Typography.small,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  tabIndicator: {
    height: 3,
    width: '80%',
    borderRadius: 2,
  },
  tabIndicatorPlaceholder: {
    height: 3,
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
});
