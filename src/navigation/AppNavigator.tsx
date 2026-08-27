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
import {ServiceSessionProvider} from '../context/ServiceSessionContext';
import {StreamProvider} from '../context/StreamContext';
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
import POSSaleScreen from '../screens/POSSaleScreen';
import SettingsScreen from '../screens/SettingsScreen';
import TableDetailScreen from '../screens/TableDetailScreen';
import TablesScreen from '../screens/TablesScreen';
import {TableWithTab} from '../types';

export type AuthStackParamList = {
  Activation: undefined;
};

export type MainTabParamList = {
  Tables: undefined;
  /** Waiter-led service, screen 1. The legacy Tables tab is untouched and stays the default. */
  ServiceFloor: undefined;
  Orders: undefined;
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
  /** Waiter-led service, screen 2. Reached only by tapping a FREE table on the floor grid. */
  ServiceOpenTable: {
    tableId: string;
    tableNumber: number;
    tableName: string | null;
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
      <MainTab.Screen
        name="Tables"
        component={TablesScreen}
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
        name="ServiceFloor"
        component={ServiceFloorScreen}
        options={{
          tabBarLabel: 'Floor',
          tabBarIcon: ({color, size}) => (
            <MaterialCommunityIcons
              name="view-grid-outline"
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
    </MainTab.Navigator>
  );
}

function MainNavigator() {
  return (
    <StreamProvider>
      <CartProvider>
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
