/**
 * THE VARIANT PICKER -- sizes and options for one menu item. Sprint 2026-09-28 brief.
 *
 * Two pieces, one rule set:
 *
 *   VariantGroupsSelector  controlled groups/options list. Embedded in RoundItemSheet (Add-a-Round)
 *                          and in VariantPicker below.
 *   VariantPicker          the POS sale's modal: the selector, the resulting unit price, and an Add
 *                          that stays DISABLED until every required group is answered.
 *
 * Every price shown comes from src/lib/variantPricing.ts, which mirrors the server's own pricing
 * (option price REPLACES base). An item with no groups never reaches this component -- it keeps
 * the one-tap add.
 */
import React, {useState} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/variantPickerCopy';
import {
  displayUnitPrice,
  isSelectionComplete,
  variantGroupsOf,
  type VariantPricedItem,
  type VariantSelection,
} from '../lib/variantPricing';

function money(currency: string, amount: number): string {
  return `${currency}${amount.toFixed(2)}`;
}

/** Names of the required groups still unanswered, for the "choose X to see the price" line. */
export function missingRequiredGroups(
  item: VariantPricedItem,
  selection: VariantSelection,
): string[] {
  return variantGroupsOf(item)
    .filter(g => g.required && !isSelectionComplete({...item, variant_groups: [g]}, selection))
    .map(g => g.name);
}

export function VariantGroupsSelector({
  item,
  selection,
  onChange,
  currency = 'N$',
}: {
  item: VariantPricedItem;
  selection: VariantSelection;
  onChange: (next: VariantSelection) => void;
  currency?: string;
}) {
  return (
    <View style={styles.groups}>
      {variantGroupsOf(item).map(group => (
        <View key={group.name} style={styles.group} testID={`variant-group-${group.name}`}>
          <View style={styles.groupHeader}>
            <Text style={styles.groupName}>{group.name}</Text>
            <Text style={group.required ? styles.requiredTag : styles.optionalTag}>
              {group.required ? Copy.VARIANT_REQUIRED_TAG : Copy.VARIANT_OPTIONAL_TAG}
            </Text>
          </View>
          <View style={styles.options}>
            {group.options.map(option => {
              const chosen = selection[group.name] === option.label;
              return (
                <Pressable
                  key={option.label}
                  testID={`variant-option-${group.name}-${option.label}`}
                  accessibilityRole="button"
                  accessibilityState={{selected: chosen}}
                  style={[styles.option, chosen && styles.optionChosen]}
                  onPress={() => {
                    const next = {...selection};
                    // Tapping the chosen option of an OPTIONAL group clears it; a required group
                    // stays answered, so the waiter cannot un-answer it by accident.
                    if (chosen && !group.required) {
                      delete next[group.name];
                    } else {
                      next[group.name] = option.label;
                    }
                    onChange(next);
                  }}>
                  <Text style={[styles.optionLabel, chosen && styles.optionLabelChosen]}>
                    {option.label}
                  </Text>
                  {group.type === 'price' && option.price !== null ? (
                    <Text style={[styles.optionPrice, chosen && styles.optionLabelChosen]}>
                      {money(currency, option.price)}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

/** The unit price line: the real price once complete, otherwise what is still to choose. */
export function VariantUnitPrice({
  item,
  selection,
  currency = 'N$',
  quantity = 1,
}: {
  item: VariantPricedItem;
  selection: VariantSelection;
  currency?: string;
  quantity?: number;
}) {
  const unit = displayUnitPrice(item, selection);
  if (unit === null) {
    return (
      <Text style={styles.choose} testID="variant-price-pending">
        {Copy.VARIANT_CHOOSE_TO_SEE_PRICE.replace(
          '{groups}',
          missingRequiredGroups(item, selection).join(', ').toLowerCase(),
        )}
      </Text>
    );
  }
  return (
    <Text style={styles.total} testID="variant-price">
      {money(currency, unit * quantity)}
    </Text>
  );
}

export default function VariantPicker({
  item,
  currency = 'N$',
  onCancel,
  onConfirm,
}: {
  item: VariantPricedItem | null;
  currency?: string;
  onCancel: () => void;
  onConfirm: (selection: VariantSelection) => void;
}) {
  const [selection, setSelection] = useState<VariantSelection>({});
  if (!item) {
    return null;
  }
  const complete = isSelectionComplete(item, selection);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.title} numberOfLines={2} testID="variant-picker-name">
              {item.name}
            </Text>
            <VariantGroupsSelector
              item={item}
              selection={selection}
              onChange={setSelection}
              currency={currency}
            />
          </ScrollView>
          <View style={styles.footer}>
            <VariantUnitPrice item={item} selection={selection} currency={currency} />
            <Pressable
              testID="variant-picker-add"
              accessibilityState={{disabled: !complete}}
              disabled={!complete}
              style={[styles.primary, !complete && styles.primaryDisabled]}
              onPress={() => {
                if (complete) {
                  onConfirm(selection);
                }
              }}>
              <Text style={styles.primaryText}>{Copy.VARIANT_ADD_TO_SALE}</Text>
            </Pressable>
            <Pressable testID="variant-picker-cancel" style={styles.secondary} onPress={onCancel}>
              <Text style={styles.secondaryText}>{Copy.VARIANT_CANCEL}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
  },
  body: {padding: Spacing.lg, gap: Spacing.sm},
  title: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary},
  groups: {gap: Spacing.md},
  group: {gap: Spacing.xs},
  groupHeader: {flexDirection: 'row', alignItems: 'center', gap: Spacing.sm},
  groupName: {...Typography.body, fontWeight: '700', color: Colors.textPrimary},
  requiredTag: {...Typography.small, color: Colors.red, fontWeight: '700'},
  optionalTag: {...Typography.small, color: Colors.textMuted},
  options: {flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm},
  option: {
    minHeight: 52,
    minWidth: 96,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionChosen: {borderColor: Colors.primary, backgroundColor: Colors.primary},
  optionLabel: {...Typography.body, fontWeight: '700', color: Colors.textPrimary},
  optionLabelChosen: {color: '#FFFFFF'},
  optionPrice: {...Typography.small, color: Colors.textSecondary},
  choose: {...Typography.small, color: Colors.textSecondary, fontWeight: '600'},
  total: {fontSize: 20, fontWeight: '800', color: Colors.textPrimary},
  footer: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  primary: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  primaryDisabled: {opacity: 0.4},
  primaryText: {...Typography.body, color: '#FFFFFF', fontWeight: '800'},
  secondary: {paddingVertical: 14, alignItems: 'center'},
  secondaryText: {...Typography.small, color: Colors.textSecondary, fontWeight: '600'},
});
