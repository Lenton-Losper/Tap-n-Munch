import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {getMenuCategories, getMenuItems, MenuCategory, MenuItem} from '../lib/api';
import {basketCount, basketSubtotal, RoundLine} from '../lib/serviceRound';
import {getRestaurantId, getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceRound'>;

function formatMoney(amount: number): string {
  return `N$${amount.toFixed(2)}`;
}

interface BasketRowProps {
  line: RoundLine;
  flagged: boolean;
  onAdjust: (delta: number) => void;
  onRemove: () => void;
  onNote: (note: string) => void;
  onSplit: () => void;
}

function BasketRow({
  line,
  flagged,
  onAdjust,
  onRemove,
  onNote,
  onSplit,
}: BasketRowProps) {
  return (
    <View style={[styles.basketRow, flagged && styles.basketRowFlagged]}>
      <View style={styles.basketRowTop}>
        <Text style={styles.basketName} numberOfLines={1}>
          {line.name}
        </Text>
        <Text style={styles.basketLineTotal}>
          {formatMoney(line.unitPrice * line.quantity)}
        </Text>
      </View>

      <View style={styles.basketRowControls}>
        <Pressable
          style={styles.qtyButton}
          onPress={() => onAdjust(-1)}
          hitSlop={6}>
          <Text style={styles.qtyButtonText}>−</Text>
        </Pressable>
        <Text style={styles.qtyValue}>{line.quantity}</Text>
        <Pressable
          style={styles.qtyButton}
          onPress={() => onAdjust(1)}
          hitSlop={6}>
          <Text style={styles.qtyButtonText}>+</Text>
        </Pressable>

        {line.quantity > 1 ? (
          <Pressable style={styles.textButton} onPress={onSplit}>
            <Text style={styles.textButtonText}>Split</Text>
          </Pressable>
        ) : null}

        <View style={styles.flexSpacer} />

        <Pressable style={styles.iconButton} onPress={onRemove} hitSlop={6}>
          <MaterialCommunityIcons
            name="trash-can-outline"
            size={20}
            color={Colors.red}
          />
        </Pressable>
      </View>

      {/* The per-line note is the field the kitchen reads. It rides with the line, and it is the
          only way to say which of three steaks is the rare one. */}
      <TextInput
        style={styles.noteInput}
        value={line.note}
        onChangeText={onNote}
        placeholder="Note for the kitchen (e.g. medium)"
        placeholderTextColor={Colors.textMuted}
        maxLength={140}
      />

      {flagged ? (
        <Text style={styles.flaggedText}>Out of stock — remove to send</Text>
      ) : null}
    </View>
  );
}

export default function ServiceRoundScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const flaggedLineIds = route.params?.outOfStockLineIds ?? [];
  const {
    table,
    waiter,
    lines,
    addItem,
    adjustQuantity,
    removeItem,
    setNote,
    splitOne,
    endSession,
  } = useServiceSession();

  const [token, setToken] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  /** Every category's items that have been loaded so far — also the search index. */
  const [itemsByCategory, setItemsByCategory] = useState<
    Record<string, MenuItem[]>
  >({});
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [basketOpen, setBasketOpen] = useState(false);

  useEffect(() => {
    getTerminalToken().then(setToken);
    getRestaurantId().then(setRestaurantId);
  }, []);

  useEffect(() => {
    if (!token || !restaurantId) {
      return;
    }
    setLoadingMenu(true);
    getMenuCategories(token, restaurantId)
      .then(cats => {
        const active = cats.filter(c => c.is_active !== false);
        setCategories(active);
        if (active.length > 0) {
          setSelectedCategory(active[0].id);
        }
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMenu(false));
  }, [token, restaurantId]);

  // Items are fetched lazily, on first tap of a category, and cached. The search index is built
  // from whatever has been loaded — the brief says so explicitly, and pre-fetching the whole menu
  // on a P5 over a venue's wifi is not something to do while a waiter waits at a table.
  useEffect(() => {
    if (!token || !restaurantId || !selectedCategory) {
      return;
    }
    if (itemsByCategory[selectedCategory]) {
      return;
    }
    setLoadingItems(true);
    getMenuItems(token, restaurantId, selectedCategory)
      .then(fetched =>
        setItemsByCategory(prev => ({...prev, [selectedCategory]: fetched})),
      )
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingItems(false));
  }, [token, restaurantId, selectedCategory, itemsByCategory]);

  const searchTerm = search.trim().toLowerCase();

  const visibleItems = useMemo(() => {
    if (searchTerm) {
      const seen = new Set<string>();
      const hits: MenuItem[] = [];
      for (const list of Object.values(itemsByCategory)) {
        for (const item of list) {
          if (seen.has(item.id)) {
            continue;
          }
          if (item.name.toLowerCase().includes(searchTerm)) {
            seen.add(item.id);
            hits.push(item);
          }
        }
      }
      return hits.filter(i => i.is_available);
    }
    return (itemsByCategory[selectedCategory ?? ''] ?? []).filter(
      i => i.is_available,
    );
  }, [itemsByCategory, searchTerm, selectedCategory]);

  const count = basketCount(lines);
  const subtotal = basketSubtotal(lines);

  const handleBack = useCallback(() => {
    // Leaving the round screen drops the held waiter, same as Send does. A half-built round
    // walked away from must not leave an identity on the device for whoever picks it up next.
    endSession();
    navigation.goBack();
  }, [endSession, navigation]);

  if (!table) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>
          No table is open on this device. Go back to the floor and pick one.
        </Text>
      </View>
    );
  }

  const heading = table.tableName
    ? `Table ${table.tableNumber} · ${table.tableName}`
    : `Table ${table.tableNumber}`;
  const ownerLabel = table.ownerName ?? waiter?.name ?? null;

  return (
    <KeyboardAvoidingView
      style={styles.wrapper}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable style={styles.backButton} onPress={handleBack}>
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.screenTitle} numberOfLines={1}>
            {heading}
          </Text>
          {/* Ruling F: adding to someone else's table is ALLOWED. Show whose it is; never block. */}
          {ownerLabel ? (
            <Text style={styles.screenSubtitle} numberOfLines={1}>
              {ownerLabel}'s table
            </Text>
          ) : null}
        </View>
        <View style={styles.backButton} />
      </View>

      <View style={styles.searchBar}>
        <MaterialCommunityIcons
          name="magnify"
          size={20}
          color={Colors.textMuted}
        />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search loaded items"
          placeholderTextColor={Colors.textMuted}
          autoCorrect={false}
        />
        {search ? (
          <Pressable onPress={() => setSearch('')} hitSlop={8}>
            <MaterialCommunityIcons
              name="close-circle"
              size={20}
              color={Colors.textMuted}
            />
          </Pressable>
        ) : null}
      </View>

      {!searchTerm ? (
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
      ) : null}

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{error}</Text>
        </View>
      ) : null}

      {loadingMenu || loadingItems ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          style={styles.itemList}
          data={visibleItems}
          keyExtractor={i => i.id}
          numColumns={2}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.itemGrid}
          renderItem={({item}) => (
            <Pressable
              style={({pressed}) => [
                styles.itemCard,
                pressed && styles.itemCardPressed,
              ]}
              onPress={() => addItem(item)}>
              <Text style={styles.itemName} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.itemPrice}>
                {formatMoney(item.base_price)}
              </Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>
                {searchTerm
                  ? 'No match in the categories loaded so far. Open a category to add it to the search.'
                  : 'No items in this category.'}
              </Text>
            </View>
          }
        />
      )}

      {/* The running basket is always reachable: a count and a running total on the bar, the
          lines themselves one tap away, and the same bar carries the single button to review. */}
      {basketOpen ? (
        <View style={styles.basketPanel}>
          <View style={styles.basketHeader}>
            <Text style={styles.basketHeaderText}>Round</Text>
            <Pressable onPress={() => setBasketOpen(false)} hitSlop={8}>
              <MaterialCommunityIcons
                name="chevron-down"
                size={26}
                color={Colors.textSecondary}
              />
            </Pressable>
          </View>
          <FlatList
            data={lines}
            keyExtractor={line => line.lineId}
            keyboardShouldPersistTaps="handled"
            style={styles.basketList}
            renderItem={({item}) => (
              <BasketRow
                line={item}
                flagged={flaggedLineIds.includes(item.lineId)}
                onAdjust={delta => adjustQuantity(item.lineId, delta)}
                onRemove={() => removeItem(item.lineId)}
                onNote={note => setNote(item.lineId, note)}
                onSplit={() => splitOne(item.lineId)}
              />
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>Nothing in this round yet.</Text>
            }
          />
        </View>
      ) : null}

      <View style={[styles.bottomBar, {paddingBottom: insets.bottom + Spacing.sm}]}>
        <Pressable
          style={styles.basketToggle}
          onPress={() => setBasketOpen(open => !open)}>
          <MaterialCommunityIcons
            name="basket-outline"
            size={22}
            color={Colors.textPrimary}
          />
          <Text style={styles.basketToggleText}>
            {count} · {formatMoney(subtotal)}
          </Text>
        </Pressable>

        <Pressable
          style={[styles.reviewButton, count === 0 && styles.buttonDisabled]}
          disabled={count === 0}
          onPress={() => navigation.navigate('ServiceRoundReview')}>
          <Text style={styles.reviewButtonText}>Review Round</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: Colors.surface},
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBlock: {flex: 1, alignItems: 'center'},
  screenTitle: {...Typography.subheading, color: Colors.textPrimary},
  screenSubtitle: {...Typography.tiny, color: Colors.textSecondary},
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    margin: Spacing.sm,
    paddingHorizontal: Spacing.md,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    ...Typography.body,
    color: Colors.textPrimary,
    padding: 0,
  },
  categoryBar: {
    flexGrow: 0,
    flexShrink: 0,
    height: 52,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    justifyContent: 'center',
  },
  categoryBarContent: {
    paddingHorizontal: Spacing.sm,
    alignItems: 'center',
    minHeight: 52,
  },
  categoryTab: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: Spacing.sm,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    minHeight: 40,
    justifyContent: 'center',
  },
  categoryTabActive: {backgroundColor: Colors.primary},
  categoryTabText: {...Typography.small, fontWeight: '600', color: '#555'},
  categoryTabTextActive: {color: Colors.white, fontWeight: '700'},
  itemList: {flex: 1},
  itemGrid: {padding: Spacing.sm, paddingBottom: Spacing.xl},
  itemCard: {
    flex: 1,
    margin: Spacing.xs,
    padding: Spacing.md,
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    minHeight: 84,
    justifyContent: 'space-between',
  },
  itemCardPressed: {opacity: 0.8},
  itemName: {...Typography.small, fontWeight: '600', color: Colors.textPrimary},
  itemPrice: {
    ...Typography.body,
    fontWeight: '700',
    color: Colors.primary,
    marginTop: Spacing.sm,
  },
  basketPanel: {
    maxHeight: 320,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  basketHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  basketHeaderText: {...Typography.subheading, color: Colors.textPrimary},
  basketList: {paddingHorizontal: Spacing.sm},
  basketRow: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: Spacing.sm,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  basketRowFlagged: {
    borderColor: Colors.red,
    backgroundColor: Colors.redLight,
  },
  basketRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  basketName: {
    flex: 1,
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  basketLineTotal: {...Typography.body, fontWeight: '700', color: Colors.textPrimary},
  basketRowControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  qtyButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  qtyButtonText: {
    color: Colors.white,
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  qtyValue: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
    minWidth: 26,
    textAlign: 'center',
  },
  textButton: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  textButtonText: {...Typography.tiny, fontWeight: '700', color: Colors.textSecondary},
  flexSpacer: {flex: 1},
  iconButton: {
    width: 38,
    height: 38,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noteInput: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
    ...Typography.small,
    color: Colors.textPrimary,
  },
  flaggedText: {
    ...Typography.tiny,
    fontWeight: '700',
    color: Colors.red,
    marginTop: Spacing.xs,
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  basketToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  basketToggleText: {...Typography.body, fontWeight: '700', color: Colors.textPrimary},
  reviewButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  reviewButtonText: {color: Colors.white, ...Typography.subheading},
  buttonDisabled: {opacity: 0.5},
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
    padding: Spacing.md,
  },
  errorText: {...Typography.body, color: Colors.red, textAlign: 'center'},
  errorBanner: {
    backgroundColor: Colors.redLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  errorBannerText: {...Typography.tiny, color: Colors.red},
});
