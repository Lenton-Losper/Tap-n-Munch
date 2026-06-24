import React from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {AuthProvider, useAuth} from '../context/AuthContext';
import {StreamProvider} from '../context/StreamContext';
import {Colors} from '../constants/theme';
import ActivationScreen from '../screens/ActivationScreen';
import OrderDetailScreen from '../screens/OrderDetailScreen';
import OrdersScreen from '../screens/OrdersScreen';
import PaymentScreen from '../screens/PaymentScreen';
import SettingsScreen from '../screens/SettingsScreen';

export type AuthStackParamList = {
  Activation: undefined;
};

export type MainStackParamList = {
  Orders: undefined;
  OrderDetail: {orderId: string};
  Payment: {
    orderId: string;
    tableNumber: number;
    total: number;
    orderNumber?: number;
    placedAt?: string;
  };
  Settings: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{headerShown: false}}>
      <AuthStack.Screen name="Activation" component={ActivationScreen} />
    </AuthStack.Navigator>
  );
}

function MainNavigator() {
  return (
    <StreamProvider>
      <MainStack.Navigator
      initialRouteName="Orders"
      screenOptions={{
        headerStyle: {backgroundColor: '#FFFFFF'},
        headerTintColor: '#111827',
        headerTitleStyle: {fontWeight: '600'},
      }}>
      <MainStack.Screen
        name="Orders"
        component={OrdersScreen}
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
