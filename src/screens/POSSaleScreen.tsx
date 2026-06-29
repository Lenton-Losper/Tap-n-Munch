import React, {useCallback, useEffect, useState} from 'react';
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
  POSOrderItem,
} from '../lib/api';
import {getRestaurantId, getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type POSSaleStackParamList = MainStackParamList & {
  POSCart: {cart: POSOrderItem[]; restaurantId: string};
};

type NavProp = NativeStackNavigationProp<POSSaleStackParamList>;

export default function POSSaleScreen() {
  const navigation = useNavigation<NavProp>();

  const [token, setToken] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<POSOrderItem[]>([]);
  const [loadingCats, setLoadingCats] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTerminalToken().then(t => setToken(t));
    getRestaurantId().then(id => setRestaurantId(id));
  }, []);

  useEffect(() => {
    if (!token || !restaurantId) {
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

  const addToCart = useCallback((item: MenuItem) => {
    setCart(prev => {
      const existing = prev.find(i => i.menuItemId === item.id);
      if (existing) {
        return prev.map(i =>
          i.menuItemId === item.id
            ? {
                ...i,
                quantity: i.quantity + 1,
                subtotal: (i.quantity + 1) * i.basePrice,
              }
            : i,
        );
      }
      return [
        ...prev,
        {
          menuItemId: item.id,
          name: item.name,
          quantity: 1,
          basePrice: item.base_price,
          subtotal: item.base_price,
        },
      ];
    });
  }, []);

  const cartTotal = cart.reduce((sum, i) => sum + i.subtotal, 0);
  const cartCount = cart.reduce((sum, i) => sum + i.quantity, 0);

  const goToCart = () => {
    if (cart.length === 0) {
      return;
    }
    navigation.navigate('POSCart', {
      cart,
      restaurantId: restaurantId ?? '',
    });
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

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.categoryBar}
        contentContainerStyle={styles.categoryBarContent}>
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
              ]}>
              {cat.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {loadingItems ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={items.filter(i => i.is_available)}
          keyExtractor={i => i.id}
          numColumns={2}
          contentContainerStyle={styles.itemGrid}
          renderItem={({item}) => {
            const inCart = cart.find(c => c.menuItemId === item.id);
            return (
              <TouchableOpacity
                style={styles.itemCard}
                onPress={() => addToCart(item)}
                activeOpacity={0.7}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemPrice}>
                  N${item.base_price.toFixed(2)}
                </Text>
                {inCart ? (
                  <View style={styles.itemBadge}>
                    <Text style={styles.itemBadgeText}>{inCart.quantity}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
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
  categoryBar: {
    maxHeight: 52,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  categoryBarContent: {paddingHorizontal: 12, alignItems: 'center'},
  categoryTab: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 8,
    borderRadius: 20,
    backgroundColor: '#F0F0F0',
  },
  categoryTabActive: {backgroundColor: Colors.primary},
  categoryTabText: {fontSize: 14, color: '#555'},
  categoryTabTextActive: {color: '#fff', fontWeight: '600'},
  itemGrid: {padding: 12, gap: 12},
  itemCard: {
    flex: 1,
    margin: 6,
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    elevation: 2,
    minHeight: 100,
    justifyContent: 'space-between',
    position: 'relative',
  },
  itemName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  itemPrice: {fontSize: 16, fontWeight: '700', color: Colors.primary},
  itemBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemBadgeText: {color: '#fff', fontSize: 12, fontWeight: '700'},
  cartButton: {
    margin: 16,
    padding: 18,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    alignItems: 'center',
  },
  cartButtonText: {color: '#fff', fontSize: 16, fontWeight: '700'},
});
