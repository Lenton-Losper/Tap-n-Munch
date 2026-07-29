import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Colors} from '../constants/theme';
import {
  getMenuCategories,
  getMenuItems,
  MenuCategory,
  MenuItem,
} from '../lib/api';
import {useCart} from '../context/CartContext';
import {getRestaurantId, getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type NavProp = NativeStackNavigationProp<MainStackParamList>;

export default function POSSaleScreen() {
  const navigation = useNavigation<NavProp>();
  const {cart, addItem, updateQuantity} = useCart();
  const [token, setToken] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loadingCats, setLoadingCats] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTerminalToken().then(t => setToken(t));
    getRestaurantId().then(id => setRestaurantId(id));
  }, []);

  useEffect(() => {
    if (!token || !restaurantId) {
      setLoadingCats(false);
      return;
    }
    setLoadingCats(true);
    getMenuCategories(token, restaurantId)
      .then(cats => {
        setCategories(cats);
        if (cats.length > 0) {
          setSelectedCategory(cats[0].id);
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoadingCats(false));
  }, [token, restaurantId]);

  useEffect(() => {
    if (!token || !restaurantId || !selectedCategory) {
      return;
    }
    setLoadingItems(true);
    getMenuItems(token, restaurantId, selectedCategory)
      .then(setItems)
      .catch(e => setError(String(e)))
      .finally(() => setLoadingItems(false));
  }, [token, restaurantId, selectedCategory]);

  const cartTotal = cart.reduce((sum, i) => sum + i.subtotal, 0);
  const cartCount = cart.reduce((sum, i) => sum + i.quantity, 0);

  const goToCart = () => {
    if (cart.length === 0) {
      return;
    }
    navigation.navigate('POSCart', {restaurantId: restaurantId ?? ''});
  };

  if (loadingCats) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!token || !restaurantId) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>
          Debug: token={token ? 'present' : 'NULL'}, restaurantId=
          {restaurantId ?? 'NULL'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.categoryBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryBarContent}
          keyboardShouldPersistTaps="handled">
          {categories.map(cat => (
            <Pressable
              key={cat.id}
              onPress={() => setSelectedCategory(cat.id)}
              style={[
                styles.categoryTab,
                selectedCategory === cat.id && styles.categoryTabActive,
              ]}>
              <Text
                style={[
                  styles.categoryTabText,
                  selectedCategory === cat.id && styles.categoryTabTextActive,
                ]}
                numberOfLines={1}>
                {cat.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {loadingItems ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          style={styles.itemList}
          data={items.filter(i => i.is_available)}
          keyExtractor={i => i.id}
          numColumns={2}
          contentContainerStyle={styles.itemGrid}
          renderItem={({item}) => {
            const inCart = cart.find(c => c.menuItemId === item.id);
            const qty = inCart?.quantity ?? 0;
            return (
              <View style={styles.itemCard}>
                <Pressable
                  onPress={() => addItem(item)}
                  style={styles.itemCardMain}
                  android_ripple={{color: '#E5E7EB'}}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemPrice}>
                    N${item.base_price.toFixed(2)}
                  </Text>
                </Pressable>
                {qty > 0 ? (
                  <View style={styles.qtyRow}>
                    <Pressable
                      style={styles.qtyButton}
                      onPress={() => updateQuantity(item.id, -1)}
                      hitSlop={6}>
                      <Text style={styles.qtyButtonText}>−</Text>
                    </Pressable>
                    <Text style={styles.qtyValue}>{qty}</Text>
                    <Pressable
                      style={styles.qtyButton}
                      onPress={() => addItem(item)}
                      hitSlop={6}>
                      <Text style={styles.qtyButtonText}>+</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    style={styles.addHint}
                    onPress={() => addItem(item)}>
                    <Text style={styles.addHintText}>Tap to add</Text>
                  </Pressable>
                )}
              </View>
            );
          }}
        />
      )}

      {cartCount > 0 ? (
        <TouchableOpacity style={styles.cartButton} onPress={goToCart}>
          <Text style={styles.cartButtonText}>
            View Cart ({cartCount}) — N${cartTotal.toFixed(2)}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#F5F5F5'},
  center: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  errorText: {color: 'red', fontSize: 14, textAlign: 'center', padding: 16},
  // Fixed height + flexShrink:0 so the bar never collapses when the cart
  // button appears or the product list scrolls (common RN flex squeeze).
  categoryBar: {
    flexGrow: 0,
    flexShrink: 0,
    height: 56,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
    justifyContent: 'center',
  },
  categoryBarContent: {
    paddingHorizontal: 12,
    alignItems: 'center',
    minHeight: 56,
  },
  categoryTab: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginRight: 8,
    borderRadius: 22,
    backgroundColor: '#F0F0F0',
    minHeight: 44,
    justifyContent: 'center',
  },
  categoryTabActive: {backgroundColor: Colors.primary},
  categoryTabText: {fontSize: 16, fontWeight: '600', color: '#555'},
  categoryTabTextActive: {color: '#fff', fontWeight: '700'},
  itemList: {flex: 1},
  itemGrid: {padding: 12, gap: 12},
  itemCard: {
    flex: 1,
    margin: 6,
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    elevation: 2,
    minHeight: 110,
    justifyContent: 'space-between',
  },
  itemCardMain: {
    flexGrow: 1,
    paddingBottom: 8,
  },
  itemName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  itemPrice: {fontSize: 16, fontWeight: '700', color: Colors.primary},
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  qtyButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  qtyButtonText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  qtyValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    minWidth: 28,
    textAlign: 'center',
  },
  addHint: {
    marginTop: 4,
    paddingVertical: 8,
    alignItems: 'center',
  },
  addHintText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9CA3AF',
  },
  cartButton: {
    flexGrow: 0,
    flexShrink: 0,
    margin: 16,
    padding: 18,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    alignItems: 'center',
  },
  cartButtonText: {color: '#fff', fontSize: 16, fontWeight: '700'},
});
