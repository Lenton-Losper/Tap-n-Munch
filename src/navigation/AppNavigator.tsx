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
import {StreamProvider} from '../context/StreamContext';
import {Colors, Typography} from '../constants/theme';
import {POSOrderItem} from '../lib/api';
import ActivationScreen from '../screens/ActivationScreen';
import OrderDetailScreen from '../screens/OrderDetailScreen';
import OrdersScreen from '../screens/OrdersScreen';
import PaymentScreen from '../screens/PaymentScreen';
import POSCartScreen from '../screens/POSCartScreen';
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
  Settings: undefined;
  POSSale: undefined;
  POSCart: {cart: POSOrderItem[]; restaurantId: string};
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
          name="POSCart"
          component={POSCartScreen}
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
