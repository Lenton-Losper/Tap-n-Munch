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
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/serviceCopy';
import {getMenuCategories, getMenuItems, MenuCategory, MenuItem} from '../lib/api';
import {applyAvailabilityOverrides} from '../lib/menuAvailabilityOverrides';
import {basketCount, basketSubtotal, RoundLine} from '../lib/serviceRound';
import {getRestaurantId, getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceRound'>;

/**
 * One tile, PLUS the category it was found under.
 *
 * The category travels with the item because the item detail view has to re-read the record to
 * confirm the dish name against, and the only route that reads menu items is the per-category one.
 * `MenuItem.category_id` cannot be used for that: the grouped response shape of
 * GET /api/menu/{restaurant}/category/{id} does not always carry a category id on the item rows,
 * so mapMenuItem defaults it to '' — which would send the detail view to a category that does not
 * exist. The key this screen filed the item under is always right.
 */
type GridEntry = {item: MenuItem; categoryId: string};

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
  /** Every category's items. The whole menu, and therefore the whole search index. */
  const [itemsByCategory, setItemsByCategory] = useState<
    Record<string, MenuItem[]>
  >({});
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [basketOpen, setBasketOpen] = useState(false);

  useEffect(() => {
    getTerminalToken().then(setToken);
    getRestaurantId().then(setRestaurantId);
  }, []);

  /**
   * THE WHOLE MENU, UP FRONT.
   *
   * v1 fetched each category on first tap and searched only what had been loaded, which made the
   * search quietly wrong rather than slow: a waiter typing "coke" before ever opening Drinks got
   * "no match", which reads as "we do not sell it". A search box that answers correctly only for
   * the parts of the menu you have already browsed is worse than no search box, because the waiter
   * cannot see which answer they are getting.
   *
   * The cost is bounded and small. Riviera is 55-200 items across a handful of categories, and no
   * count is hard-coded anywhere — the loop is driven by whatever the categories call returns. The
   * first category is awaited so the grid paints immediately; the rest stream in behind it, and a
   * category that fails to load leaves the others intact rather than emptying the screen.
   */
  useEffect(() => {
    if (!token || !restaurantId) {
      return;
    }
    let cancelled = false;
    setLoadingMenu(true);

    (async () => {
      try {
        const cats = await getMenuCategories(token, restaurantId);
        if (cancelled) {
          return;
        }
        const active = cats.filter(c => c.is_active !== false);
        setCategories(active);
        if (active.length === 0) {
          return;
        }
        setSelectedCategory(active[0].id);

        // First category first, so the waiter can start tapping while the rest arrive.
        const first = await getMenuItems(token, restaurantId, active[0].id);
        if (cancelled) {
          return;
        }
        setItemsByCategory(prev => ({...prev, [active[0].id]: first}));
        setLoadingMenu(false);

        await Promise.all(
          active.slice(1).map(async cat => {
            try {
              const fetched = await getMenuItems(token, restaurantId, cat.id);
              if (!cancelled) {
                setItemsByCategory(prev => ({...prev, [cat.id]: fetched}));
              }
            } catch {
              // One category failing must not blank the others. That category simply stays
              // empty and out of the search index until the screen is reopened.
            }
          }),
        );
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setLoadingMenu(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, restaurantId]);

  /**
   * FOLD IN ANY AVAILABILITY CHANGE THIS DEVICE HAS HAD CONFIRMED, every time the grid is
   * re-entered.
   *
   * The menu above is fetched ONCE, on mount, and nothing invalidates it. The moment a waiter can
   * take a dish off the menu from the item detail view, that cache can outlive the truth: they hide
   * the dish, press back, and the tile they left behind still says it is orderable. Adding it to a
   * customer's round from that tile is not a cosmetic staleness — it is an order for food the venue
   * has just said it does not have.
   *
   * Coming back from the detail view is a FOCUS, which is why this hangs off useFocusEffect rather
   * than route params: Android's hardware back does not go through the screen's own back control,
   * and that is the exit a waiter actually uses.
   *
   * NOT OPTIMISTIC, and this is the load-bearing part: applyAvailabilityOverrides can only return
   * what the SERVER confirmed. lib/menuAvailabilityOverrides.ts is written from exactly one place,
   * inside the 200 branch of the availability call. Nothing here ever runs on a guess.
   *
   * The identity check is what stops this looping: an unchanged fold returns the same object and
   * setState bails out rather than re-rendering the grid on every focus.
   */
  useFocusEffect(
    useCallback(() => {
      setItemsByCategory(prev => {
        let changed = false;
        const next: Record<string, MenuItem[]> = {};
        for (const [categoryId, list] of Object.entries(prev)) {
          const patched = applyAvailabilityOverrides(list);
          next[categoryId] = patched;
          if (patched !== list) {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, []),
  );

  const searchTerm = search.trim().toLowerCase();

  /**
   * WHY UNAVAILABLE ITEMS ARE NO LONGER FILTERED OUT.
   *
   * They used to be dropped from the grid and from the search index entirely. Two things changed
   * with the terminal being able to take a dish off the menu:
   *
   *   - A dish taken off the menu has to STILL BE FINDABLE, or nobody can put it back. Restoring
   *     it needs the item detail view, and the only way to that view is a tile.
   *   - "No match" for a dish the venue does sell reads as "we do not sell it" — the exact
   *     complaint that made this screen load the whole menu up front rather than search only what
   *     had been browsed.
   *
   * An unavailable tile is rendered greyed and CANNOT be added to a round; see the renderItem.
   */
  const visibleItems = useMemo<GridEntry[]>(() => {
    const entries: GridEntry[] = [];
    if (searchTerm) {
      const seen = new Set<string>();
      for (const [categoryId, list] of Object.entries(itemsByCategory)) {
        for (const item of list) {
          if (seen.has(item.id)) {
            continue;
          }
          if (item.name.toLowerCase().includes(searchTerm)) {
            seen.add(item.id);
            entries.push({item, categoryId});
          }
        }
      }
      return entries;
    }
    const categoryId = selectedCategory ?? '';
    for (const item of itemsByCategory[categoryId] ?? []) {
      entries.push({item, categoryId});
    }
    return entries;
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
          placeholder={Copy.ROUND_SEARCH_PLACEHOLDER}
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

      {loadingMenu ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          style={styles.itemList}
          data={visibleItems}
          keyExtractor={entry => entry.item.id}
          numColumns={2}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.itemGrid}
          renderItem={({item: entry}) => (
            <View
              style={[
                styles.itemCard,
                !entry.item.is_available && styles.itemCardUnavailable,
              ]}>
              {/*
                THE ORDER-BUILDING TAP, UNCHANGED. Tapping the body of a tile adds the item to the
                round and does nothing else. A tile the server says is unavailable cannot be added
                at all — that is what `disabled` is for, and it is why an unavailable tile is shown
                greyed rather than hidden.
              */}
              <Pressable
                style={({pressed}) => [
                  styles.itemCardBody,
                  pressed && styles.itemCardPressed,
                ]}
                disabled={!entry.item.is_available}
                onPress={() => addItem(entry.item)}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {entry.item.name}
                </Text>
                <Text style={styles.itemPrice}>
                  {formatMoney(entry.item.base_price)}
                </Text>
              </Pressable>

              {/*
                THE ONLY WAY TO THE ITEM DETAIL VIEW, and therefore the only way to the control
                that takes a dish off the menu.

                DELIBERATELY AN EXPLICIT, SEPARATE TARGET. Not the tile's own tap — that builds an
                order and must keep doing so — and NOT a swipe or a long-press: a mis-swipe while
                scrolling a menu mid-service must never be able to reach a control that removes a
                dish for every customer in the restaurant. Whoever is tempted to "save a tap" by
                moving this onto a gesture is re-introducing exactly the risk the design removed.
              */}
              <Pressable
                style={styles.itemInfoButton}
                hitSlop={8}
                accessibilityRole="button"
                onPress={() =>
                  navigation.navigate('MenuItemDetail', {
                    itemId: entry.item.id,
                    categoryId: entry.categoryId,
                    tappedName: entry.item.name,
                  })
                }>
                <MaterialCommunityIcons
                  name="information-outline"
                  size={20}
                  color={Colors.textMuted}
                />
              </Pressable>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>
                {searchTerm
                  ? Copy.ROUND_SEARCH_NO_MATCH
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
  /**
   * The greyed tile. It is on screen and can be opened, but its body is `disabled` so it cannot be
   * added to a round — the greying is the visible half of that, not decoration.
   */
  itemCardUnavailable: {backgroundColor: Colors.surface, opacity: 0.55},
  itemCardBody: {flex: 1, justifyContent: 'space-between'},
  itemCardPressed: {opacity: 0.8},
  /** Small, in the corner, and away from the middle of the tile where an add-tap lands. */
  itemInfoButton: {
    position: 'absolute',
    top: Spacing.xs,
    right: Spacing.xs,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
