/**
 * THE ITEM SHEET — what a waiter gets when they tap something on the menu.
 *
 * ================================================================================================
 * WHY IT EXISTS
 * ================================================================================================
 *
 * Tapping an item used to add one un-noted unit straight to the basket, and the note was typed
 * afterwards on the basket row, with a Split button to peel a unit off when the note applied to
 * only some of them. That put the note somewhere other than where the waiter was deciding it, and
 * made per-unit notes a recovery step rather than the natural outcome.
 *
 * This is the interaction the CUSTOMER already gets on the QR menu (web:
 * components/menu/item-detail-modal.tsx) — tap, choose a quantity, write a note, confirm — so both
 * halves of the venue think about an item the same way. The component does not transfer (React DOM
 * and Tailwind over there, React Native here); the interaction does.
 *
 * ONE ITEM, ONE NOTE. Two taps on Cappuccino with different notes give two basket lines, because
 * serviceRound.addLine merges only into a line carrying the SAME note. That is what replaces the
 * Split button, and it falls out of the model rather than needing an affordance.
 *
 * ================================================================================================
 * WHAT IT DOES NOT DO
 * ================================================================================================
 *
 * No variants, sizes or add-ons. A RoundLine is item, quantity and note; the round flow has never
 * modelled the rest, and building it to mirror a sheet would be the wrong order. Owner's ruling,
 * 2026-09-06.
 *
 * It also ignores `allow_special_instructions`, which gates the note field on the CUSTOMER's sheet.
 * That is a customer-facing menu choice, and a waiter losing the note field on a dish because of a
 * QR setting would be baffling. Same ruling.
 */
import React, {useState} from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/roundItemSheetCopy';
import {
  clampLineQuantity,
  MAX_LINE_QUANTITY,
  MAX_NOTE_LENGTH,
  MIN_LINE_QUANTITY,
} from '../lib/serviceRound';

export type RoundItemSheetTarget = {
  id: string;
  name: string;
  base_price: number;
  /** Seeded when reopening an existing basket line, absent when adding a new one. */
  editing?: {lineId: string; quantity: number; note: string};
};

export default function RoundItemSheet({
  item,
  currency = 'N$',
  onCancel,
  onConfirm,
}: {
  item: RoundItemSheetTarget | null;
  currency?: string;
  onCancel: () => void;
  onConfirm: (result: {quantity: number; note: string; lineId?: string}) => void;
}) {
  /**
   * Seeded from the line when editing, fresh otherwise. The sheet is mounted only while `item` is
   * set (the caller renders it conditionally), so a lazy initialiser is enough — there is no
   * seeding effect to keep in sync mid-edit, which is how the customer's sheet does it too.
   */
  const [quantity, setQuantity] = useState(() =>
    clampLineQuantity(item?.editing?.quantity ?? 1),
  );
  const [note, setNote] = useState(() => item?.editing?.note ?? '');

  if (!item) {
    return null;
  }

  const atCeiling = quantity >= MAX_LINE_QUANTITY;
  const editing = item.editing != null;
  const lineTotal = (Number.isFinite(item.base_price) ? item.base_price : 0) * quantity;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.title} numberOfLines={2} testID="item-sheet-name">
              {item.name}
            </Text>

            <Text style={styles.label}>{Copy.ITEM_SHEET_NOTE_LABEL}</Text>
            <TextInput
              testID="item-sheet-note"
              style={styles.noteInput}
              value={note}
              onChangeText={setNote}
              placeholder={Copy.ITEM_SHEET_NOTE_PLACEHOLDER}
              placeholderTextColor={Colors.textMuted}
              multiline
              // The same ceiling the customer's sheet uses for the same dish (280), not the 140
              // the old inline field imposed.
              maxLength={MAX_NOTE_LENGTH}
            />
            <Text style={styles.hint}>{Copy.ITEM_SHEET_NOTE_HINT}</Text>

            <Text style={styles.label}>{Copy.ITEM_SHEET_QUANTITY_LABEL}</Text>
            <View style={styles.stepper}>
              <Pressable
                testID="item-sheet-minus"
                style={styles.stepButton}
                disabled={quantity <= MIN_LINE_QUANTITY}
                onPress={() => setQuantity(q => clampLineQuantity(q - 1))}>
                <MaterialCommunityIcons
                  name="minus"
                  size={28}
                  color={quantity <= MIN_LINE_QUANTITY ? Colors.textMuted : Colors.textPrimary}
                />
              </Pressable>
              <Text style={styles.quantity} testID="item-sheet-quantity">
                {quantity}
              </Text>
              <Pressable
                testID="item-sheet-plus"
                style={styles.stepButton}
                // Stopped AT the ceiling rather than allowed and refused later: the server takes
                // no line above MAX_LINE_QUANTITY, and finding that out at submit with a table
                // waiting is the failure the customer's sheet already prevents.
                disabled={atCeiling}
                onPress={() => setQuantity(q => clampLineQuantity(q + 1))}>
                <MaterialCommunityIcons
                  name="plus"
                  size={28}
                  color={atCeiling ? Colors.textMuted : Colors.textPrimary}
                />
              </Pressable>
            </View>
            {atCeiling ? (
              <Text style={styles.hint} testID="item-sheet-capped">
                {Copy.ITEM_SHEET_QUANTITY_CAPPED.replace('{max}', String(MAX_LINE_QUANTITY))}
              </Text>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <Text style={styles.total} testID="item-sheet-total">
              {currency}
              {lineTotal.toFixed(2)}
            </Text>
            <Pressable
              testID="item-sheet-confirm"
              style={styles.primary}
              onPress={() =>
                onConfirm({
                  quantity: clampLineQuantity(quantity),
                  note: note.trim(),
                  lineId: item.editing?.lineId,
                })
              }>
              <Text style={styles.primaryText}>
                {editing ? Copy.ITEM_SHEET_SAVE : Copy.ITEM_SHEET_ADD}
              </Text>
            </Pressable>
            <Pressable testID="item-sheet-cancel" style={styles.secondary} onPress={onCancel}>
              <Text style={styles.secondaryText}>{Copy.ITEM_SHEET_CANCEL}</Text>
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
    // Capped so the sheet cannot fill a 640dp P5 and leave no context behind it.
    maxHeight: '85%',
  },
  body: {padding: Spacing.lg, gap: Spacing.sm},
  title: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary},
  label: {...Typography.small, color: Colors.textSecondary, marginTop: Spacing.sm},
  hint: {...Typography.small, color: Colors.textMuted},
  noteInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    minHeight: 72,
    textAlignVertical: 'top',
    ...Typography.body,
    color: Colors.textPrimary,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    marginVertical: Spacing.xs,
  },
  stepButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quantity: {
    fontSize: 40,
    fontWeight: '800',
    color: Colors.textPrimary,
    minWidth: 60,
    textAlign: 'center',
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  total: {fontSize: 20, fontWeight: '800', color: Colors.textPrimary},
  primary: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  primaryText: {...Typography.body, color: '#FFFFFF', fontWeight: '800'},
  secondary: {paddingVertical: 14, alignItems: 'center'},
  secondaryText: {...Typography.small, color: Colors.textSecondary, fontWeight: '600'},
});
