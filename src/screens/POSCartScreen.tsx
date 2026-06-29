import React, {useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {RouteProp, useNavigation, useRoute} from '@react-navigation/native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {createPOSOrder, POSOrderItem} from '../lib/api';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type POSCartRouteProp = RouteProp<MainStackParamList, 'POSCart'>;
type NavProp = NativeStackNavigationProp<MainStackParamList>;

export default function POSCartScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<POSCartRouteProp>();
  const {cart, restaurantId} = route.params;
  const [charging, setCharging] = useState(false);

  const total = cart.reduce((sum, i) => sum + i.subtotal, 0);
  const subtotal = total;

  const handleCharge = async () => {
    if (cart.length === 0) {
      return;
    }
    setCharging(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const result = await createPOSOrder(token, {
        restaurantId,
        items: cart,
        subtotal,
        total,
      });

      navigation.replace('Payment', {
        orderId: result.orderId,
        tableNumber: 0,
        total,
        orderNumber: result.orderNumber,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to create order';
      Alert.alert('Error', message);
    } finally {
      setCharging(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Order Summary</Text>

      <FlatList
        data={cart}
        keyExtractor={i => i.menuItemId}
        style={styles.list}
        renderItem={({item}: {item: POSOrderItem}) => (
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={styles.itemQty}>x{item.quantity}</Text>
            </View>
            <Text style={styles.itemSubtotal}>N${item.subtotal.toFixed(2)}</Text>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalAmount}>N${total.toFixed(2)}</Text>
      </View>

      <TouchableOpacity
        style={[styles.chargeButton, charging && styles.chargeButtonDisabled]}
        onPress={handleCharge}
        disabled={charging}>
        {charging ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.chargeButtonText}>
            Charge N${total.toFixed(2)}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#F5F5F5', padding: 16},
  title: {fontSize: 22, fontWeight: '700', color: '#1a1a1a', marginBottom: 16},
  list: {flex: 1},
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
  },
  rowLeft: {flex: 1},
  itemName: {fontSize: 15, fontWeight: '600', color: '#1a1a1a'},
  itemQty: {fontSize: 13, color: '#666', marginTop: 2},
  itemSubtotal: {fontSize: 15, fontWeight: '700', color: '#1a1a1a'},
  separator: {height: 4},
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
    marginTop: 8,
  },
  totalLabel: {fontSize: 18, fontWeight: '700', color: '#1a1a1a'},
  totalAmount: {fontSize: 20, fontWeight: '800', color: '#1a1a1a'},
  chargeButton: {
    backgroundColor: '#2E7D32',
    borderRadius: 12,
    padding: 18,
    alignItems: 'center',
    marginTop: 8,
  },
  chargeButtonDisabled: {opacity: 0.6},
  chargeButtonText: {color: '#fff', fontSize: 18, fontWeight: '700'},
});
