import React from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import {NavigatorScreenParams} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {AuthProvider, useAuth} from '../context/AuthContext';
import {CartProvider} from '../context/CartContext';
import {ServiceModelProvider, useServiceModel} from '../context/ServiceModelContext';
import {ServiceSessionProvider} from '../context/ServiceSessionContext';
import {StreamProvider} from '../context/StreamContext';
import {showsCounterSaleTab, usesWaiterLedService} from '../lib/serviceModel';
import {Colors, Typography} from '../constants/theme';
import ActivationScreen from '../screens/ActivationScreen';
import OrderDetailScreen from '../screens/OrderDetailScreen';
import OrdersScreen from '../screens/OrdersScreen';
import PaymentScreen from '../screens/PaymentScreen';
import RefundAuthScreen from '../screens/RefundAuthScreen';
import RefundConfirmScreen from '../screens/RefundConfirmScreen';
import RefundPinScreen from '../screens/RefundPinScreen';
import POSCartScreen from '../screens/POSCartScreen';
import ServiceFloorScreen from '../screens/ServiceFloorScreen';
import ServiceOpenTableScreen from '../screens/ServiceOpenTableScreen';
import ServiceRoundReviewScreen from '../screens/ServiceRoundReviewScreen';
import ServiceRoundScreen from '../screens/ServiceRoundScreen';
import ServiceTableScreen from '../screens/ServiceTableScreen';
import POSSaleScreen from '../screens/POSSaleScreen';
import SettingsScreen from '../screens/SettingsScreen';
import TableDetailScreen from '../screens/TableDetailScreen';
import TablesScreen from '../screens/TablesScreen';
import {TableWithTab} from '../types';

export type AuthStackParamList = {
  Activation: undefined;
};

/**
 * THREE TABS, ALWAYS. The tab NAMES do not change with the venue model — what changes is which
 * component `Tables` renders and whether `POSSale` is mounted at all.
 *
 * v1 of this feature added a fourth "Floor" tab beside Tables/Orders/Sale, which put two ways to
 * create an order on one device: a waiter could ring a round onto a tab from one tab and a
 * standalone paid-now sale from another, for the same food, at the same table. There is one way to
 * take an order per venue, and the venue decides which.
 */
export type MainTabParamList = {
  /** Floor grid at a table-service venue; the legacy occupied-tables list at a counter one. */
  Tables: undefined;
  Orders: undefined;
  /** Mounted only at counter-service venues, and when the model is not yet known. */
  POSSale: undefined;
};

export type MainStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  TableDetail: {table: TableWithTab};
  OrderDetail: {orderId: string};
  Payment: {
    orderId: string;
    tableId?: string;
    tableNumber: number;
    total: number;
    orderNumber?: number;
    placedAt?: string;
  };
  RefundAuth: {
    orderId: string;
    /** Absent for individually-paid (walk-up/Sale) orders — no table involved. */
    tableId?: string;
    tableNumber?: number;
    orderNumber?: number;
    total: number;
  };
  RefundPin: {
    userId: string;
    userName: string;
    orderId: string;
    tableId?: string;
    tableNumber?: number;
    orderNumber?: number;
    total: number;
  };
  RefundConfirm: {
    authTokenId: string;
    userId: string;
    orderId: string;
    tableId?: string;
    tableNumber?: number;
    orderNumber?: number;
    total: number;
  };
  Settings: undefined;
  POSSale: undefined;
  POSCart: {restaurantId: string};
  /**
   * The PIN gate. Reached by tapping a FREE table on the floor, or by pressing Add Round on a
   * table this device has not opened — in which case the open ADOPTS the running tab.
   *
   * `next` decides where a successful open lands; see the screen for why. Defaults to 'table'.
   */
  ServiceOpenTable: {
    tableId: string;
    tableNumber: number;
    tableName: string | null;
    next?: 'table' | 'round';
  };
  /**
   * THE TABLE VIEW. What has been ordered, the running bill, which lines are outstanding versus
   * ready, and Add Round.
   *
   * Reached with NO PIN — reading a table is not an attributable act. The tab id travels in params
   * rather than through ServiceSessionContext precisely because there may be no session: a waiter
   * looking at a colleague's table has not PINned in and does not need to.
   */
  ServiceTable: {
    tableId: string;
    tableNumber: number;
    tableName: string | null;
    tabId: string;
    ownerName: string | null;
    ownerUserId: string | null;
    /** Set by the open screen when `already_open` came back true. Success, not an error. */
    adoptedExistingTab?: boolean;
    /** Set when this open took the table off another waiter. They must be told. */
    handedOverFrom?: {user_id: string; name: string} | null;
  };
  /**
   * Waiter-led service, screen 3. The tab, the table and the basket all live in
   * ServiceSessionContext rather than in params, so a round survives navigating to review and
   * back without being serialised through the navigator.
   *
   * `outOfStockLineIds` is the one thing that has to travel: it is the answer to a 409 the review
   * screen received, and every line it names must light up at once.
   */
  ServiceRound: {outOfStockLineIds?: string[]} | undefined;
  /** Waiter-led service, screen 4. The ONE review screen; Send lives here. */
  ServiceRoundReview: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();
const MainTab = createBottomTabNavigator<MainTabParamList>();

function MainTabNavigator() {
  const {model} = useServiceModel();

  // THE ONE DECISION. Both questions — which Tables screen, and is there a Sale tab — are answered
  // from the same resolved model through the two helpers, so they cannot drift into disagreeing
  // about the same venue. 'unknown' takes the counter-service branch on both, which is today's app.
  const waiterLed = usesWaiterLedService(model);
  const showSale = showsCounterSaleTab(model);

  return (
    <MainTab.Navigator
      initialRouteName="Tables"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarStyle: {
          backgroundColor: Colors.background,
          borderTopColor: Colors.border,
        },
        tabBarLabelStyle: {
          ...Typography.tiny,
          fontWeight: '600',
        },
      }}>
      {/* SAME TAB, SAME POSITION, SAME LABEL — a different screen behind it. At a table-service
          venue "Tables" is the floor grid (every table, open and free); at a counter one it stays
          the occupied-tables settlement list it has always been. */}
      <MainTab.Screen
        name="Tables"
        component={waiterLed ? ServiceFloorScreen : TablesScreen}
        options={{
          tabBarLabel: 'Tables',
          tabBarIcon: ({color, size}) => (
            <MaterialCommunityIcons
              name="table-furniture"
              size={size}
              color={color}
            />
          ),
        }}
      />
      <MainTab.Screen
        name="Orders"
        component={OrdersScreen}
        options={{
          tabBarLabel: 'Orders',
          tabBarIcon: ({color, size}) => (
            <MaterialCommunityIcons
              name="clipboard-list-outline"
              size={size}
              color={color}
            />
          ),
        }}
      />
      {/* NOT MOUNTED at a table-service venue: the waiter-led flow REPLACES it, so there is one
          way to take an order rather than two. Still mounted when the model is unknown — see
          lib/serviceModel.ts on why a missing field must never cost a venue its till. */}
      {showSale ? (
        <MainTab.Screen
          name="POSSale"
          component={POSSaleScreen}
          options={{
            tabBarLabel: 'Sale',
            tabBarIcon: ({color, size}) => (
              <MaterialCommunityIcons
                name="cart-plus"
                size={size}
                color={color}
              />
            ),
          }}
        />
      ) : null}
    </MainTab.Navigator>
  );
}

function MainNavigator() {
  return (
    <StreamProvider>
      <CartProvider>
        <ServiceModelProvider>
        <ServiceSessionProvider>
        <MainStack.Navigator
        initialRouteName="MainTabs"
        screenOptions={{
          headerStyle: {backgroundColor: '#FFFFFF'},
          headerTintColor: '#111827',
          headerTitleStyle: {fontWeight: '600'},
        }}>
        <MainStack.Screen
          name="MainTabs"
          component={MainTabNavigator}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="TableDetail"
          component={TableDetailScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="OrderDetail"
          component={OrderDetailScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="Payment"
          component={PaymentScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="RefundAuth"
          component={RefundAuthScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="RefundPin"
          component={RefundPinScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="RefundConfirm"
          component={RefundConfirmScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="POSCart"
          component={POSCartScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="ServiceOpenTable"
          component={ServiceOpenTableScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="ServiceTable"
          component={ServiceTableScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="ServiceRound"
          component={ServiceRoundScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="ServiceRoundReview"
          component={ServiceRoundReviewScreen}
          options={{headerShown: false}}
        />
        <MainStack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            title: 'Settings',
            headerStyle: {backgroundColor: Colors.background},
          }}
        />
      </MainStack.Navigator>
        </ServiceSessionProvider>
        </ServiceModelProvider>
      </CartProvider>
    </StreamProvider>
  );
}

function RootNavigator() {
  const {isAuthenticated, isLoading} = useAuth();

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#111827" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {isAuthenticated ? <MainNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{headerShown: false}}>
      <AuthStack.Screen name="Activation" component={ActivationScreen} />
    </AuthStack.Navigator>
  );
}

export default function AppNavigator() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.background,
  },
});
