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
import {clearPersistedPaymentState} from '../components/PaymentStateMachine';
import {createPOSOrder, POSOrderItem} from '../lib/api';
import {useCart} from '../context/CartContext';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type POSCartRouteProp = RouteProp<MainStackParamList, 'POSCart'>;
type NavProp = NativeStackNavigationProp<MainStackParamList>;

export default function POSCartScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<POSCartRouteProp>();
  const {cart, updateQuantity, clearCart, saleAttemptKey} = useCart();
  const {restaurantId} = route.params;
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

      if (!saleAttemptKey) {
        // Cannot happen: the key is generated when the first item is rung up and the charge
        // button is unreachable with an empty cart. Refusing beats sending no key, which is the
        // exact defect #328 fixes.
        throw new Error('This sale could not be identified. Clear it and ring it up again.');
      }

      const result = await createPOSOrder(token, {
        restaurantId,
        items: cart,
        subtotal,
        total,
        // #328. Stable across retries of THIS sale, so a retry after a failed launch returns the
        // order that already exists rather than stranding it and creating another.
        idempotencyKey: saleAttemptKey,
      });

      // Prevent a prior order's persisted SUCCESS from painting "Payment successful"
      // on this new charge before Finatic opens.
      await clearPersistedPaymentState();

      clearCart();
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

  if (cart.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.headerBack}
            onPress={() => navigation.goBack()}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Text style={styles.headerBackText}>← Sale</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Order Summary</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>Your cart is empty.</Text>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}>
            <Text style={styles.backButtonText}>Back to Sale</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          style={styles.headerBack}
          onPress={() => navigation.goBack()}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={styles.headerBackText}>← Sale</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Order Summary</Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList
        data={cart}
        keyExtractor={i => i.menuItemId}
        style={styles.list}
        renderItem={({item}: {item: POSOrderItem}) => (
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.itemName}>{item.name}</Text>
            </View>
            <View style={styles.qtyControls}>
              <TouchableOpacity
                style={styles.qtyButton}
                onPress={() => updateQuantity(item.menuItemId, -1)}>
                <Text style={styles.qtyButtonText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.itemQty}>{item.quantity}</Text>
              <TouchableOpacity
                style={styles.qtyButton}
                onPress={() => updateQuantity(item.menuItemId, 1)}>
                <Text style={styles.qtyButtonText}>+</Text>
              </TouchableOpacity>
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
        disabled={charging || cart.length === 0}>
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    minHeight: 44,
  },
  headerBack: {
    paddingVertical: 8,
    paddingRight: 12,
    minWidth: 72,
  },
  headerBackText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  headerSpacer: {minWidth: 72},
  title: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    textAlign: 'center',
  },
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
  rowLeft: {flex: 1, marginRight: 8},
  itemName: {fontSize: 15, fontWeight: '600', color: '#1a1a1a'},
  qtyControls: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
  },
  qtyButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#F0F0F0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  qtyButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    lineHeight: 20,
  },
  itemQty: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
    minWidth: 28,
    textAlign: 'center',
    marginHorizontal: 4,
  },
  itemSubtotal: {fontSize: 15, fontWeight: '700', color: '#1a1a1a'},
  separator: {height: 4},
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 20,
    textAlign: 'center',
  },
  backButton: {
    backgroundColor: '#2E7D32',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  backButtonText: {color: '#fff', fontSize: 16, fontWeight: '700'},
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
